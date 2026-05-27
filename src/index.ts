import 'dotenv/config';
import crypto from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getOrgConfig, listEnabledOrgs, getDefaultOrgId } from './config.js';

const {
    PORT = '3000',
    MCP_API_KEY,
    BASE_URL = 'http://localhost:3000',
    NODE_ENV = 'development'
} = process.env;

if (!MCP_API_KEY) throw new Error('Missing MCP_API_KEY');

const enabledOrgs = listEnabledOrgs();
if (enabledOrgs.length === 0) {
    throw new Error('No organizations configured. Set ORG_* environment variables.');
}

console.log(`✓ Loaded ${enabledOrgs.length} organization(s): ${enabledOrgs.map(o => o.orgId).join(', ')}`);

// Helper functions for PKCE
function generateCodeVerifier(): string {
    return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// Store OAuth states temporarily (use Redis in production)
const authStates = new Map<string, { timestamp: number; orgId: string; codeVerifier?: string }>();

// Clean up expired states every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [state, data] of authStates.entries()) {
        if (now - data.timestamp > 10 * 60 * 1000) { // 10 minutes
            authStates.delete(state);
        }
    }
}, 5 * 60 * 1000);

type SalesforceTokenResponse = {
    access_token: string;
    token_type: string;
    instance_url?: string;
    refresh_token?: string;
    expires_in?: number;
};

async function sfRequest<T>(
    path: string,
    userToken: string,
    instanceUrl: string,
    init?: RequestInit
): Promise<T> {
    const url = `${instanceUrl}${path}`;

    const res = await fetch(url, {
        ...init,
        headers: {
            Authorization: `Bearer ${userToken}`,
            'Content-Type': 'application/json',
            ...(init?.headers ?? {})
        }
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Salesforce API error: ${res.status} ${text}`);
    }

    // Some Salesforce responses (PATCH/DELETE) are empty
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
}

// Extract user Salesforce token from request header
// Format: "token|instanceUrl"
function extractUserToken(req: Request): { token: string; instanceUrl: string } | null {
    const auth = req.header('X-SF-Token') || '';
    const parts = auth.split('|');

    if (parts.length !== 2) return null;

    const [token, instanceUrl] = parts;
    if (!token || !instanceUrl) return null;

    return { token, instanceUrl };
}

function requireApiKey(req: Request, res: Response, next: NextFunction) {
    const auth = req.header('authorization') || '';
    const apiKey = auth.startsWith('Bearer ') ? auth.slice(7) : null;

    if (!apiKey || apiKey !== MCP_API_KEY) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }

    next();
}

// Create MCP server with user context
function createMcpServer(userToken: string, instanceUrl: string, apiVersion: string = 'v65.0') {
    const server = new McpServer({
        name: 'salesforce-mcp',
        version: '1.0.0'
    });

    server.tool(
        'list_objects',
        'List available Salesforce sObjects',
        {},
        async () => {
            const data = await sfRequest<{
                sobjects: Array<{
                    name: string;
                    label: string;
                    queryable: boolean;
                    createable: boolean;
                    updateable: boolean;
                    deletable: boolean;
                }>;
            }>(`/services/data/${apiVersion}/sobjects`, userToken, instanceUrl);

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(data.sobjects, null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'describe_object',
        'Describe metadata for a Salesforce object',
        {
            object: z.string()
        },
        async ({ object }) => {
            const data = await sfRequest(
                `/services/data/${apiVersion}/sobjects/${encodeURIComponent(object)}/describe`,
                userToken,
                instanceUrl
            );

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(data, null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'query_records',
        'Run a SOQL query',
        {
            soql: z.string()
        },
        async ({ soql }) => {
            let allRecords: any[] = [];
            let nextRecordsUrl: string | null = `/services/data/${apiVersion}/query?q=${encodeURIComponent(soql)}`;

            while (nextRecordsUrl) {
                const data = (await sfRequest(
                    nextRecordsUrl,
                    userToken,
                    instanceUrl
                )) as any;
                allRecords = allRecords.concat(data.records || []);
                nextRecordsUrl = data.nextRecordsUrl || null;
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ totalSize: allRecords.length, records: allRecords, done: true }, null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'tooling_query',
        'Run a SOQL query against Salesforce Tooling API',
        {
            soql: z.string()
        },
        async ({ soql }) => {
            let allRecords: any[] = [];
            let nextRecordsUrl: string | null = `/services/data/${apiVersion}/tooling/query?q=${encodeURIComponent(soql)}`;

            while (nextRecordsUrl) {
                const data = (await sfRequest(
                    nextRecordsUrl,
                    userToken,
                    instanceUrl
                )) as any;
                allRecords = allRecords.concat(data.records || []);
                nextRecordsUrl = data.nextRecordsUrl || null;
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ totalSize: allRecords.length, records: allRecords, done: true }, null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'get_org_info',
        'Get org-level metadata (language, timezone, edition, limits)',
        {},
        async () => {
            const data = (await sfRequest(
                `/services/data/${apiVersion}/query?q=${encodeURIComponent('SELECT Id, Name, DefaultLanguage, TimeZoneSidKey, OrganizationType, InstanceName, IsSandbox, LanguageLocaleKey FROM Organization LIMIT 1')}`,
                userToken,
                instanceUrl
            )) as any;

            const org = data.records?.[0] || {};
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(org, null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'get_picklist_values',
        'Extract picklist values from an object field',
        {
            object: z.string(),
            field: z.string()
        },
        async ({ object, field }) => {
            const data = (await sfRequest(
                `/services/data/${apiVersion}/sobjects/${encodeURIComponent(object)}/describe`,
                userToken,
                instanceUrl
            )) as any;

            const fieldDesc = data.fields?.find((f: any) => f.name === field);
            if (!fieldDesc) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ error: `Field ${field} not found on object ${object}` }, null, 2)
                        }
                    ]
                };
            }

            const picklistValues = fieldDesc.picklistValues || [];
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            object,
                            field,
                            values: picklistValues.map((v: any) => ({
                                label: v.label,
                                value: v.value,
                                active: v.active
                            }))
                        }, null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'get_record',
        'Get a Salesforce record by object and id',
        {
            object: z.string(),
            id: z.string()
        },
        async ({ object, id }) => {
            const data = await sfRequest(
                `/services/data/${apiVersion}/sobjects/${encodeURIComponent(object)}/${encodeURIComponent(id)}`,
                userToken,
                instanceUrl
            );

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(data, null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'create_record',
        'Create a Salesforce record',
        {
            object: z.string(),
            fields: z.record(z.any())
        },
        async ({ object, fields }) => {
            const data = await sfRequest(
                `/services/data/${apiVersion}/sobjects/${encodeURIComponent(object)}`,
                userToken,
                instanceUrl,
                {
                    method: 'POST',
                    body: JSON.stringify(fields)
                }
            );

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(data, null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'update_record',
        'Update a Salesforce record',
        {
            object: z.string(),
            id: z.string(),
            fields: z.record(z.any())
        },
        async ({ object, id, fields }) => {
            await sfRequest(
                `/services/data/${apiVersion}/sobjects/${encodeURIComponent(object)}/${encodeURIComponent(id)}`,
                userToken,
                instanceUrl,
                {
                    method: 'PATCH',
                    body: JSON.stringify(fields)
                }
            );

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ success: true, id }, null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'delete_record',
        'Delete a Salesforce record',
        {
            object: z.string(),
            id: z.string()
        },
        async ({ object, id }) => {
            await sfRequest(
                `/services/data/${apiVersion}/sobjects/${encodeURIComponent(object)}/${encodeURIComponent(id)}`,
                userToken,
                instanceUrl,
                {
                    method: 'DELETE'
                }
            );

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ success: true, id }, null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'count_records',
        'Get record count for any object',
        {
            object: z.string()
        },
        async ({ object }) => {
            const soql = `SELECT COUNT() FROM ${object}`;
            const data = (await sfRequest(
                `/services/data/${apiVersion}/query?q=${encodeURIComponent(soql)}`,
                userToken,
                instanceUrl
            )) as any;

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ object, count: data.totalSize }, null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'get_validation_rules',
        'Get all validation rules for an object or all objects',
        {
            object: z.string().optional()
        },
        async ({ object }) => {
            const whereClause = object ? ` WHERE EntityDefinition.DeveloperName = '${object}'` : '';
            const soql = `SELECT Id, EntityDefinition.DeveloperName, ValidationName, ErrorDisplayField, ErrorMessage, Active FROM ValidationRule${whereClause} LIMIT 200`;
            const data = (await sfRequest(
                `/services/data/${apiVersion}/tooling/query?q=${encodeURIComponent(soql)}`,
                userToken,
                instanceUrl
            )) as any;

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(data.records || [], null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'get_flows',
        'List all flows with status and type',
        {
            status: z.string().optional()
        },
        async ({ status }) => {
            const whereClause = status ? ` WHERE Status = '${status}'` : '';
            const soql = `SELECT Id, ApiName, Label, ProcessType, Status, TriggerType, LastModifiedDate FROM FlowDefinitionView${whereClause} LIMIT 200`;
            const data = (await sfRequest(
                `/services/data/${apiVersion}/query?q=${encodeURIComponent(soql)}`,
                userToken,
                instanceUrl
            )) as any;

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(data.records || [], null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'get_audit_trail',
        'Get recent admin configuration changes from SetupAuditTrail',
        {
            days: z.number().optional()
        },
        async ({ days = 30 }) => {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - days);
            const isoDate = cutoffDate.toISOString().split('T')[0];
            const soql = `SELECT CreatedDate, CreatedBy.Name, Action, Section, Display FROM SetupAuditTrail WHERE CreatedDate >= ${isoDate}T00:00:00Z ORDER BY CreatedDate DESC LIMIT 2000`;

            let allRecords: any[] = [];
            let nextRecordsUrl: string | null = `/services/data/${apiVersion}/query?q=${encodeURIComponent(soql)}`;

            while (nextRecordsUrl) {
                const data = (await sfRequest(
                    nextRecordsUrl,
                    userToken,
                    instanceUrl
                )) as any;
                allRecords = allRecords.concat(data.records || []);
                nextRecordsUrl = data.nextRecordsUrl || null;
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(allRecords, null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'get_sharing_settings',
        'Get Org-Wide Default sharing model per object',
        {},
        async () => {
            const soql = `SELECT QualifiedApiName, InternalSharingModel, ExternalSharingModel FROM EntityDefinition WHERE IsCustomizable = true LIMIT 200`;
            const data = (await sfRequest(
                `/services/data/${apiVersion}/tooling/query?q=${encodeURIComponent(soql)}`,
                userToken,
                instanceUrl
            )) as any;

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(data.records || [], null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'get_named_credentials',
        'List all Named Credentials',
        {},
        async () => {
            const soql = `SELECT Id, DeveloperName, MasterLabel, Endpoint, Protocol FROM NamedCredential LIMIT 200`;
            const data = (await sfRequest(
                `/services/data/${apiVersion}/tooling/query?q=${encodeURIComponent(soql)}`,
                userToken,
                instanceUrl
            )) as any;

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(data.records || [], null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'get_installed_packages',
        'List all installed managed packages',
        {},
        async () => {
            const soql = `SELECT Id, SubscriberPackage.Name, SubscriberPackage.NamespacePrefix, SubscriberPackageVersion.MajorVersion FROM InstalledSubscriberPackage LIMIT 200`;
            const data = (await sfRequest(
                `/services/data/${apiVersion}/tooling/query?q=${encodeURIComponent(soql)}`,
                userToken,
                instanceUrl
            )) as any;

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(data.records || [], null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'search_records',
        'Run a SOSL search in Salesforce',
        {
            sosl: z.string()
        },
        async ({ sosl }) => {
            const data = await sfRequest(
                `/services/data/${apiVersion}/search/?q=${encodeURIComponent(sosl)}`,
                userToken,
                instanceUrl
            );

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(data, null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'get_workflow_rules',
        'List all workflow rules',
        {
            object: z.string().optional()
        },
        async ({ object }) => {
            const whereClause = object ? ` WHERE TableEnumOrId = '${object}'` : '';
            const soql = `SELECT Id, Name, TableEnumOrId, TriggerType, Active FROM WorkflowRule${whereClause} LIMIT 200`;
            const data = (await sfRequest(
                `/services/data/${apiVersion}/tooling/query?q=${encodeURIComponent(soql)}`,
                userToken,
                instanceUrl
            )) as any;

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(data.records || [], null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'get_custom_metadata',
        'List Custom Metadata Types and optionally their records',
        {
            type_name: z.string().optional()
        },
        async ({ type_name }) => {
            if (type_name) {
                const soql = `SELECT Id, DeveloperName FROM ${type_name}__mdt LIMIT 200`;
                const data = (await sfRequest(
                    `/services/data/${apiVersion}/query?q=${encodeURIComponent(soql)}`,
                    userToken,
                    instanceUrl
                )) as any;
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ type: type_name, records: data.records || [] }, null, 2)
                        }
                    ]
                };
            } else {
                const soql = `SELECT Id, DeveloperName, MasterLabel FROM CustomMetadata LIMIT 200`;
                const data = (await sfRequest(
                    `/services/data/${apiVersion}/tooling/query?q=${encodeURIComponent(soql)}`,
                    userToken,
                    instanceUrl
                )) as any;
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(data.records || [], null, 2)
                        }
                    ]
                };
            }
        }
    );

    server.tool(
        'get_custom_settings',
        'List Custom Settings definitions and their values',
        {
            setting_name: z.string().optional()
        },
        async ({ setting_name }) => {
            if (setting_name) {
                const soql = `SELECT Id, DeveloperName FROM ${setting_name}__c LIMIT 200`;
                const data = (await sfRequest(
                    `/services/data/${apiVersion}/query?q=${encodeURIComponent(soql)}`,
                    userToken,
                    instanceUrl
                )) as any;
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({ setting: setting_name, records: data.records || [] }, null, 2)
                        }
                    ]
                };
            } else {
                const soql = `SELECT Id, DeveloperName, MasterLabel FROM CustomSetting LIMIT 200`;
                const data = (await sfRequest(
                    `/services/data/${apiVersion}/tooling/query?q=${encodeURIComponent(soql)}`,
                    userToken,
                    instanceUrl
                )) as any;
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(data.records || [], null, 2)
                        }
                    ]
                };
            }
        }
    );

    server.tool(
        'get_reports_dashboards',
        'List all reports and dashboards',
        {
            type: z.enum(['reports', 'dashboards', 'both']).optional()
        },
        async ({ type = 'both' }) => {
            let reportData: any = [];
            let dashboardData: any = [];

            if (type === 'reports' || type === 'both') {
                const reportSoql = `SELECT Id, Name, FolderName, CreatedDate, LastModifiedDate FROM Report LIMIT 200`;
                const reports = (await sfRequest(
                    `/services/data/${apiVersion}/query?q=${encodeURIComponent(reportSoql)}`,
                    userToken,
                    instanceUrl
                )) as any;
                reportData = reports.records || [];
            }

            if (type === 'dashboards' || type === 'both') {
                const dashboardSoql = `SELECT Id, Title, FolderName, CreatedDate, LastModifiedDate FROM Dashboard LIMIT 200`;
                const dashboards = (await sfRequest(
                    `/services/data/${apiVersion}/query?q=${encodeURIComponent(dashboardSoql)}`,
                    userToken,
                    instanceUrl
                )) as any;
                dashboardData = dashboards.records || [];
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({ reports: reportData, dashboards: dashboardData }, null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'get_page_layouts',
        'List page layouts and their object assignments',
        {
            object: z.string().optional()
        },
        async ({ object }) => {
            const whereClause = object ? ` WHERE EntityDefinitionId.QualifiedApiName = '${object}'` : '';
            const soql = `SELECT Id, Name, EntityDefinitionId.QualifiedApiName, LayoutType FROM Layout${whereClause} LIMIT 200`;
            const data = (await sfRequest(
                `/services/data/${apiVersion}/tooling/query?q=${encodeURIComponent(soql)}`,
                userToken,
                instanceUrl
            )) as any;

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(data.records || [], null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'get_approval_processes',
        'Get all approval processes and their step definitions',
        {
            object: z.string().optional()
        },
        async ({ object }) => {
            const whereClause = object ? ` WHERE TableEnumOrId = '${object}'` : '';
            const soql = `SELECT Id, Name, TableEnumOrId, Active FROM ProcessDefinition${whereClause} LIMIT 200`;
            const data = (await sfRequest(
                `/services/data/${apiVersion}/tooling/query?q=${encodeURIComponent(soql)}`,
                userToken,
                instanceUrl
            )) as any;

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(data.records || [], null, 2)
                    }
                ]
            };
        }
    );

    server.tool(
        'get_field_permissions',
        'Get field-level security (read/edit) for fields by profile',
        {
            object: z.string(),
            profile_name: z.string().optional()
        },
        async ({ object, profile_name }) => {
            const whereClause = profile_name ? ` AND Parent.Profile.Name = '${profile_name}'` : '';
            const soql = `SELECT Field, PermissionsRead, PermissionsEdit, Parent.Profile.Name FROM FieldPermissions WHERE SobjectType = '${object}'${whereClause} LIMIT 1000`;

            let allRecords: any[] = [];
            let nextRecordsUrl: string | null = `/services/data/${apiVersion}/tooling/query?q=${encodeURIComponent(soql)}`;

            while (nextRecordsUrl) {
                const data = (await sfRequest(
                    nextRecordsUrl,
                    userToken,
                    instanceUrl
                )) as any;
                allRecords = allRecords.concat(data.records || []);
                nextRecordsUrl = data.nextRecordsUrl || null;
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(allRecords, null, 2)
                    }
                ]
            };
        }
    );

    return server;
}

const app = express();
app.use(express.json());

// List available organizations
app.get('/orgs', (_req: Request, res: Response) => {
    const orgs = listEnabledOrgs();
    res.json({
        orgs: orgs.map(org => ({
            id: org.orgId,
            name: org.name,
            authorizeUrl: `${BASE_URL}/oauth/authorize?org_id=${org.orgId}`
        }))
    });
});

// OAuth authorization endpoint
app.get('/oauth/authorize', (req: Request, res: Response) => {
    const orgId = (req.query.org_id as string) || getDefaultOrgId();

    if (!orgId) {
        return res.status(400).json({ error: 'Missing org_id parameter' });
    }

    const orgConfig = getOrgConfig(orgId);
    if (!orgConfig) {
        return res.status(404).json({
            error: `Organization ${orgId} not found or disabled`,
            availableOrgs: listEnabledOrgs().map(o => o.orgId)
        });
    }

    const state = crypto.randomBytes(32).toString('hex');
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    authStates.set(state, { timestamp: Date.now(), orgId, codeVerifier });

    const authUrl = new URL(`${orgConfig.loginUrl}/services/oauth2/authorize`);
    authUrl.searchParams.set('client_id', orgConfig.clientId);
    authUrl.searchParams.set('redirect_uri', `${BASE_URL}/callback`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'full');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('prompt', 'login');

    res.redirect(authUrl.toString());
});

// Alias for /authorize (PKCE-aware - forward code_challenge but don't require code_verifier)
app.get('/authorize', (req: Request, res: Response) => {
    const orgId = (req.query.org_id as string) || getDefaultOrgId();
    const { code_challenge, code_challenge_method, state } = req.query;

    if (!orgId) {
        return res.status(400).json({ error: 'Missing org_id parameter' });
    }

    const orgConfig = getOrgConfig(orgId);
    if (!orgConfig) {
        return res.status(404).json({
            error: `Organization ${orgId} not found or disabled`,
            availableOrgs: listEnabledOrgs().map(o => o.orgId)
        });
    }

    const stateValue = (state as string) || crypto.randomBytes(32).toString('hex');
    authStates.set(stateValue, { timestamp: Date.now(), orgId });

    const authUrl = new URL(`${orgConfig.loginUrl}/services/oauth2/authorize`);
    authUrl.searchParams.set('client_id', orgConfig.clientId);
    authUrl.searchParams.set('redirect_uri', `${BASE_URL}/callback`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'full');
    authUrl.searchParams.set('state', stateValue);

    if (code_challenge) {
        authUrl.searchParams.set('code_challenge', code_challenge as string);
        authUrl.searchParams.set('code_challenge_method', code_challenge_method as string || 'S256');
    }

    res.redirect(authUrl.toString());
});

// OAuth callback handler - shared between /callback and /oauth/callback
const handleOAuthCallback = async (req: Request, res: Response) => {
    const { code, state, error } = req.query;

    if (error) {
        return res.status(400).send(`
            <h1>Authorization Error</h1>
            <p>${error}</p>
            <p>Please try again or contact your administrator.</p>
        `);
    }

    if (!authStates.has(state as string)) {
        return res.status(400).send('<h1>Invalid state parameter</h1>');
    }

    const stateData = authStates.get(state as string)!;
    authStates.delete(state as string);

    const orgId = stateData.orgId || getDefaultOrgId();
    if (!orgId) {
        return res.status(400).send('<h1>No organization configured</h1>');
    }

    const orgConfig = getOrgConfig(orgId);

    if (!orgConfig) {
        return res.status(404).send(`<h1>Organization ${orgId} not found</h1>`);
    }

    try {
        const tokenUrl = `${orgConfig.loginUrl}/services/oauth2/token`;
        const bodyParams = {
            grant_type: 'authorization_code',
            client_id: orgConfig.clientId,
            client_secret: orgConfig.clientSecret,
            redirect_uri: `${BASE_URL}/callback`,
            code: code as string,
            ...(stateData.codeVerifier && { code_verifier: stateData.codeVerifier })
        };
        const body = new URLSearchParams(bodyParams);

        const tokenRes = await fetch(tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body
        });

        const data = await tokenRes.json() as SalesforceTokenResponse;

        if (!tokenRes.ok) {
            return res.status(400).send(`
                <h1>Token Exchange Error</h1>
                <p>${(data as any).error_description || 'Unknown error'}</p>
            `);
        }

        const { access_token, instance_url, refresh_token } = data;

        // Set security headers to prevent caching of sensitive information
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('X-Frame-Options', 'DENY');

        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Salesforce OAuth - Success</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 40px; }
                    .container { max-width: 600px; }
                    .success { color: #28a745; font-size: 24px; margin-bottom: 20px; }
                    .token-box { background: #f0f0f0; padding: 15px; border-radius: 4px; word-break: break-all; margin: 20px 0; font-family: monospace; }
                    code { font-family: monospace; word-break: break-all; }
                    .instructions { margin-top: 30px; padding: 15px; background: #e7f3ff; border-radius: 4px; }
                    .warning { background: #fff3cd; padding: 12px; border-radius: 4px; margin: 20px 0; border-left: 4px solid #ffc107; }
                    .copy-btn { background: #007bff; color: white; padding: 8px 12px; border: none; border-radius: 4px; cursor: pointer; font-family: monospace; }
                    .org-info { background: #f9f9f9; padding: 15px; border-radius: 4px; margin: 20px 0; border: 1px solid #ddd; }
                </style>
                <script>
                    function copyToClipboard(text, elementId) {
                        navigator.clipboard.writeText(text).then(() => {
                            const btn = document.getElementById(elementId);
                            const original = btn.textContent;
                            btn.textContent = '✓ Copied!';
                            setTimeout(() => btn.textContent = original, 2000);
                        });
                    }
                </script>
            </head>
            <body>
                <div class="container">
                    <h1>✅ Authentication Successful</h1>

                    <div class="org-info">
                        <strong>Organization:</strong> ${orgConfig.name} (${orgId})<br>
                        <strong>Instance:</strong> ${instance_url}
                    </div>

                    <div class="warning">
                        <strong>⚠️ Important:</strong> This page contains sensitive credentials. Do NOT bookmark, screenshot, or share this page.
                    </div>

                    <h2>Your Access Token</h2>
                    <p>Use this token to authenticate API requests:</p>
                    <div class="token-box">
                        <code id="headerValue">X-SF-Token: ${access_token}|${instance_url}</code>
                        <br><br>
                        <button class="copy-btn" onclick="copyToClipboard(document.getElementById('headerValue').textContent, 'copyBtn')">
                            📋 Copy Header
                        </button>
                    </div>

                    <div class="instructions">
                        <h3>How to use with MCP:</h3>
                        <p>Add these headers to your MCP requests:</p>
                        <pre><code>Authorization: Bearer ${MCP_API_KEY.substring(0, 10)}...
X-SF-Token: [token from above]
X-Org-Id: ${orgId}</code></pre>
                    </div>

                    <div class="instructions">
                        <h3>📌 Important Notes:</h3>
                        <ul>
                            <li>This token will expire after ${data.expires_in ? Math.floor(data.expires_in / 3600) + ' hours' : 'a period of time'}.</li>
                            <li>Your refresh token has been securely stored on the server.</li>
                            <li>Keep this token secret - treat it like a password.</li>
                            <li>Close this page or open a new tab when done.</li>
                        </ul>
                    </div>

                    <p style="margin-top: 40px; color: #666; font-size: 12px;">
                        <strong>Timestamp:</strong> ${new Date().toISOString()}
                    </p>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        res.status(500).send(`
            <h1>Server Error</h1>
            <p>${error instanceof Error ? error.message : 'Unknown error'}</p>
        `);
    }
};

// Primary callback endpoint (as configured in Salesforce Connected App)
app.get('/callback', handleOAuthCallback);

// Legacy callback endpoint alias
app.get('/oauth/callback', handleOAuthCallback);

// Health check
app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'salesforce-mcp' });
});

// Register endpoint - return organizations
app.post('/register', (req: Request, res: Response) => {
    const orgs = listEnabledOrgs();
    res.json({
        organizations: orgs.map(org => ({
            id: org.orgId,
            name: org.name,
            client_id: org.clientId,
            redirect_uris: [`${BASE_URL}/callback`],
            authorize_url: `${BASE_URL}/oauth/authorize?org_id=${org.orgId}`
        }))
    });
});

// MCP endpoint
app.all('/mcp', requireApiKey, async (req: Request, res: Response) => {
    const orgId = (req.query.org_id as string) ||
                  req.header('X-Org-Id') ||
                  getDefaultOrgId();

    const orgConfig = getOrgConfig(orgId || '');

    if (!orgConfig) {
        const availableOrgs = listEnabledOrgs();
        return res.status(404).json({
            error: 'Organization not found',
            availableOrgs: availableOrgs.map(org => org.orgId),
            hint: 'Provide org_id via query param or X-Org-Id header'
        });
    }

    const auth = extractUserToken(req);

    if (!auth) {
        return res.status(401).json({
            error: 'Missing Salesforce authentication',
            message: 'Provide access token in X-SF-Token header as: "token|instanceUrl"',
            authorize_url: `${BASE_URL}/oauth/authorize?org_id=${orgId}`
        });
    }

    const { token: userToken, instanceUrl } = auth;
    const server = createMcpServer(userToken, instanceUrl, orgConfig.apiVersion);
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined
    });

    res.on('close', () => {
        transport.close();
    });

    await server.connect(transport);

    if (req.method === 'GET') {
        await transport.handleRequest(req, res);
        return;
    }

    await transport.handleRequest(req, res, req.body);
});

app.listen(Number(PORT), () => {
    console.log(`\n✓ Salesforce MCP running on port ${PORT}`);
    console.log(`✓ Base URL: ${BASE_URL}`);
    console.log(`✓ Environment: ${NODE_ENV}`);
    console.log(`\n📋 Organizations:`);
    listEnabledOrgs().forEach(org => {
        console.log(`  • ${org.name} (${org.orgId}) → ${BASE_URL}/oauth/authorize?org_id=${org.orgId}`);
    });
    console.log(`\n📡 MCP Endpoints:`);
    console.log(`  • ${BASE_URL}/mcp (provide X-SF-Token & X-Org-Id headers)`);
    console.log(`  • ${BASE_URL}/orgs (list available organizations)`);
    console.log();
});
