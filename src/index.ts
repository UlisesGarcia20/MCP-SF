import 'dotenv/config';
import crypto from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const {
    PORT = '3000',
    MCP_API_KEY,
    SF_LOGIN_URL = 'https://creative-shark-mhybdo-dev-ed.trailblaze.my.salesforce.com',
    SF_CLIENT_ID,
    SF_CLIENT_SECRET,
    SF_API_VERSION = 'v61.0',
    BASE_URL = 'http://localhost:3000'
} = process.env;

if (!MCP_API_KEY) throw new Error('Missing MCP_API_KEY');
if (!SF_CLIENT_ID) throw new Error('Missing SF_CLIENT_ID');
if (!SF_CLIENT_SECRET) throw new Error('Missing SF_CLIENT_SECRET');

// Store OAuth states temporarily (use Redis in production)
const authStates = new Map<string, { timestamp: number; instance_url?: string }>();

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
function createMcpServer(userToken: string, instanceUrl: string) {
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
            }>(`/services/data/${SF_API_VERSION}/sobjects`, userToken, instanceUrl);

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
                `/services/data/${SF_API_VERSION}/sobjects/${encodeURIComponent(object)}/describe`,
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
            let nextRecordsUrl: string | null = `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;

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
            let nextRecordsUrl: string | null = `/services/data/${SF_API_VERSION}/tooling/query?q=${encodeURIComponent(soql)}`;

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
                `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent('SELECT Id, Name, DefaultLanguage, TimeZoneSidKey, OrganizationType, InstanceName, IsSandbox, LanguageLocaleKey FROM Organization LIMIT 1')}`,
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
                `/services/data/${SF_API_VERSION}/sobjects/${encodeURIComponent(object)}/describe`,
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
                `/services/data/${SF_API_VERSION}/sobjects/${encodeURIComponent(object)}/${encodeURIComponent(id)}`,
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
                `/services/data/${SF_API_VERSION}/sobjects/${encodeURIComponent(object)}`,
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
                `/services/data/${SF_API_VERSION}/sobjects/${encodeURIComponent(object)}/${encodeURIComponent(id)}`,
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
                `/services/data/${SF_API_VERSION}/sobjects/${encodeURIComponent(object)}/${encodeURIComponent(id)}`,
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
                `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`,
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
                `/services/data/${SF_API_VERSION}/tooling/query?q=${encodeURIComponent(soql)}`,
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
                `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`,
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
            let nextRecordsUrl: string | null = `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;

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
                `/services/data/${SF_API_VERSION}/tooling/query?q=${encodeURIComponent(soql)}`,
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
                `/services/data/${SF_API_VERSION}/tooling/query?q=${encodeURIComponent(soql)}`,
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
                `/services/data/${SF_API_VERSION}/tooling/query?q=${encodeURIComponent(soql)}`,
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
                `/services/data/${SF_API_VERSION}/search/?q=${encodeURIComponent(sosl)}`,
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
                `/services/data/${SF_API_VERSION}/tooling/query?q=${encodeURIComponent(soql)}`,
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
                    `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`,
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
                    `/services/data/${SF_API_VERSION}/tooling/query?q=${encodeURIComponent(soql)}`,
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
                    `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`,
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
                    `/services/data/${SF_API_VERSION}/tooling/query?q=${encodeURIComponent(soql)}`,
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
                    `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(reportSoql)}`,
                    userToken,
                    instanceUrl
                )) as any;
                reportData = reports.records || [];
            }

            if (type === 'dashboards' || type === 'both') {
                const dashboardSoql = `SELECT Id, Title, FolderName, CreatedDate, LastModifiedDate FROM Dashboard LIMIT 200`;
                const dashboards = (await sfRequest(
                    `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(dashboardSoql)}`,
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
                `/services/data/${SF_API_VERSION}/tooling/query?q=${encodeURIComponent(soql)}`,
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
                `/services/data/${SF_API_VERSION}/tooling/query?q=${encodeURIComponent(soql)}`,
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
            let nextRecordsUrl: string | null = `/services/data/${SF_API_VERSION}/tooling/query?q=${encodeURIComponent(soql)}`;

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

// OAuth authorization endpoint
app.get('/oauth/authorize', (req: Request, res: Response) => {
    const state = crypto.randomBytes(32).toString('hex');
    authStates.set(state, { timestamp: Date.now() });

    const authUrl = new URL(`${SF_LOGIN_URL}/services/oauth2/authorize`);
    authUrl.searchParams.set('client_id', SF_CLIENT_ID!);
    authUrl.searchParams.set('redirect_uri', `${BASE_URL}/callback`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'full');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('prompt', 'login');

    res.redirect(authUrl.toString());
});

// Alias for /authorize (PKCE-aware - forward code_challenge but don't require code_verifier)
app.get('/authorize', (req: Request, res: Response) => {
    const { code_challenge, code_challenge_method, state } = req.query;
    authStates.set(state as string, { timestamp: Date.now() });

    const authUrl = new URL(`${SF_LOGIN_URL}/services/oauth2/authorize`);
    authUrl.searchParams.set('client_id', SF_CLIENT_ID!);
    authUrl.searchParams.set('redirect_uri', `${BASE_URL}/callback`);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'full');
    authUrl.searchParams.set('state', (state as string) || crypto.randomBytes(32).toString('hex'));

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
    authStates.delete(state as string);

    try {
        const tokenUrl = `${SF_LOGIN_URL}/services/oauth2/token`;
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: SF_CLIENT_ID!,
            client_secret: SF_CLIENT_SECRET!,
            redirect_uri: `${BASE_URL}/callback`,
            code: code as string
        });

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

        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Salesforce OAuth - Success</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 40px; }
                    .container { max-width: 600px; }
                    .success { color: #28a745; font-size: 24px; margin-bottom: 20px; }
                    .token-box { background: #f0f0f0; padding: 15px; border-radius: 4px; word-break: break-all; margin: 20px 0; }
                    code { font-family: monospace; }
                    .instructions { margin-top: 30px; padding: 15px; background: #e7f3ff; border-radius: 4px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>✅ Authentication Successful</h1>
                    <p><strong>Org URL:</strong> ${instance_url}</p>

                    <h2>Access Token</h2>
                    <div class="token-box">
                        <code>${access_token}</code>
                    </div>

                    <div class="instructions">
                        <h3>How to use with MCP:</h3>
                        <p>Copy the access token above and use it in the header:</p>
                        <code>X-SF-Token: ${access_token}|${instance_url}</code>
                        <p><small><strong>Refresh Token:</strong> ${refresh_token}</small></p>
                    </div>
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

// Register endpoint - return client configuration
app.post('/register', (req: Request, res: Response) => {
    res.json({
        client_id: SF_CLIENT_ID,
        client_secret: SF_CLIENT_SECRET,
        redirect_uris: [`${BASE_URL}/callback`]
    });
});

// MCP endpoint
app.all('/mcp', requireApiKey, async (req: Request, res: Response) => {
    const auth = extractUserToken(req);

    if (!auth) {
        return res.status(401).json({
            error: 'Missing Salesforce authentication',
            message: 'Provide access token in X-SF-Token header as: "token|instanceUrl"',
            authorize_url: `${BASE_URL}/oauth/authorize`
        });
    }

    const { token: userToken, instanceUrl } = auth;
    const server = createMcpServer(userToken, instanceUrl);
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
    console.log(`Salesforce MCP running on port ${PORT}`);
    console.log(`OAuth authorize URL: ${BASE_URL}/oauth/authorize`);
});
