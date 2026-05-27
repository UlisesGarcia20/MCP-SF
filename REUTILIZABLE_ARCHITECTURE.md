# MCPServer - Reutilizable Architecture (All Environment Variables)

## Current State

### Environment Variables (`.env`)
```env
PORT=3000
MCP_API_KEY=una_key_larga
SF_LOGIN_URL=https://login.salesforce.com
SF_CLIENT_ID=3MVG9F...
SF_CLIENT_SECRET=EF1C4D...
SF_API_VERSION=v65.0
BASE_URL=https://salesforce-mcp-proxy...
```

**Issue:** Each deployment needs different values, but they're per-instance.

---

## Solution: Multi-Org via Environment Variables (No Code Changes)

### Concept
- **No Setup/Registration endpoints needed**
- **All configuration via `.env`**
- **Supports multiple orgs through environment prefixes**
- **Deploy once, use for multiple customers**

---

## Architecture: Multi-Org from .env

### `.env` Structure for Multiple Orgs

```env
# Global Configuration
PORT=3000
MCP_API_KEY=master-api-key-xyz
BASE_URL=https://salesforce-mcp.example.com
DEFAULT_ORG=org-clienta

# Organization A
ORG_CLIENTA_ENABLED=true
ORG_CLIENTA_NAME=Client A Corp
ORG_CLIENTA_SF_LOGIN_URL=https://login.salesforce.com
ORG_CLIENTA_SF_CLIENT_ID=AY6WOqQ2...
ORG_CLIENTA_SF_CLIENT_SECRET=EF18A4E...
ORG_CLIENTA_SF_API_VERSION=v65.0

# Organization B
ORG_CLIENTB_ENABLED=true
ORG_CLIENTB_NAME=Client B Inc
ORG_CLIENTB_SF_LOGIN_URL=https://login.salesforce.com
ORG_CLIENTB_SF_CLIENT_ID=HWOqQ3...
ORG_CLIENTB_SF_CLIENT_SECRET=F56GH78IJ90KL...
ORG_CLIENTB_SF_API_VERSION=v66.0

# Organization C (Sandbox)
ORG_SANDBOX_ENABLED=true
ORG_SANDBOX_NAME=Client C Sandbox
ORG_SANDBOX_SF_LOGIN_URL=https://test.salesforce.com
ORG_SANDBOX_SF_CLIENT_ID=G9FofAY6PhRtHWOqQ4...
ORG_SANDBOX_SF_CLIENT_SECRET=Z99YY87WW66VV55UU...
ORG_SANDBOX_SF_API_VERSION=v65.0
```

### Code Changes (Minimal)

**Step 1: Create `src/config.ts`**

```typescript
interface OrgConfig {
  orgId: string;
  name: string;
  loginUrl: string;
  clientId: string;
  clientSecret: string;
  apiVersion: string;
  enabled: boolean;
}

export function loadOrgConfigs(): Map<string, OrgConfig> {
  const orgs = new Map<string, OrgConfig>();
  
  // Parse environment variables by prefix
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('ORG_')) continue;
    
    const parts = key.split('_');
    if (parts.length < 3) continue;
    
    const orgId = parts.slice(1, -1).join('_').toLowerCase();
    const field = parts[parts.length - 1];
    
    if (!orgs.has(orgId)) {
      orgs.set(orgId, {
        orgId,
        name: '',
        loginUrl: 'https://login.salesforce.com',
        clientId: '',
        clientSecret: '',
        apiVersion: 'v65.0',
        enabled: false
      });
    }
    
    const org = orgs.get(orgId)!;
    
    switch (field) {
      case 'NAME':
        org.name = value || '';
        break;
      case 'ENABLED':
        org.enabled = value === 'true';
        break;
      case 'SF_LOGIN_URL':
        org.loginUrl = value || 'https://login.salesforce.com';
        break;
      case 'SF_CLIENT_ID':
        org.clientId = value || '';
        break;
      case 'SF_CLIENT_SECRET':
        org.clientSecret = value || '';
        break;
      case 'SF_API_VERSION':
        org.apiVersion = value || 'v65.0';
        break;
    }
  }
  
  // Validate all enabled orgs have required fields
  for (const [orgId, org] of orgs) {
    if (org.enabled) {
      if (!org.clientId || !org.clientSecret) {
        throw new Error(`Org ${orgId} enabled but missing SF_CLIENT_ID or SF_CLIENT_SECRET`);
      }
    }
  }
  
  return orgs;
}

export function getOrgConfig(orgId: string): OrgConfig | null {
  const configs = loadOrgConfigs();
  const org = configs.get(orgId.toLowerCase());
  
  if (!org || !org.enabled) {
    return null;
  }
  
  return org;
}

export function listEnabledOrgs(): OrgConfig[] {
  const configs = loadOrgConfigs();
  return Array.from(configs.values()).filter(org => org.enabled);
}
```

**Step 2: Modify OAuth Flow in `index.ts`**

```typescript
import { getOrgConfig, listEnabledOrgs } from './config';

// List available orgs (for debugging/discovery)
app.get('/orgs', (req: Request, res: Response) => {
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
  const orgId = (req.query.org_id as string) || process.env.DEFAULT_ORG;
  
  if (!orgId) {
    return res.status(400).json({ error: 'Missing org_id parameter' });
  }

  const orgConfig = getOrgConfig(orgId);
  if (!orgConfig) {
    return res.status(404).json({ error: `Organization ${orgId} not found or disabled` });
  }

  const state = crypto.randomBytes(32).toString('hex');
  authStates.set(state, { 
    timestamp: Date.now(),
    orgId
  });

  const authUrl = new URL(`${orgConfig.loginUrl}/services/oauth2/authorize`);
  authUrl.searchParams.set('client_id', orgConfig.clientId);
  authUrl.searchParams.set('redirect_uri', `${BASE_URL}/callback`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'full');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('prompt', 'login');

  res.redirect(authUrl.toString());
});

// OAuth callback handler
const handleOAuthCallback = async (req: Request, res: Response) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(`<h1>Authorization Error</h1><p>${error}</p>`);
  }

  if (!authStates.has(state as string)) {
    return res.status(400).send('<h1>Invalid state parameter</h1>');
  }

  const stateData = authStates.get(state as string)!;
  authStates.delete(state as string);

  const orgId = stateData.orgId || process.env.DEFAULT_ORG;
  const orgConfig = getOrgConfig(orgId);

  if (!orgConfig) {
    return res.status(404).send('<h1>Org not found</h1>');
  }

  try {
    const tokenUrl = `${orgConfig.loginUrl}/services/oauth2/token`;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: orgConfig.clientId,
      client_secret: orgConfig.clientSecret,
      redirect_uri: `${BASE_URL}/callback`,
      code: code as string
    });

    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });

    const data = (await tokenRes.json()) as SalesforceTokenResponse;

    if (!tokenRes.ok) {
      return res.status(400).send(`<h1>Token Exchange Error</h1><p>${(data as any).error_description}</p>`);
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
          <p><strong>Organization:</strong> ${orgId}</p>
          <p><strong>Org URL:</strong> ${instance_url}</p>

          <h2>Access Token</h2>
          <div class="token-box">
            <code>${access_token}</code>
          </div>

          <div class="instructions">
            <h3>How to use with MCP:</h3>
            <p>Copy the access token and use it in the header:</p>
            <code>X-SF-Token: ${access_token}|${instance_url}</code>
            <p><small><strong>Refresh Token:</strong> ${refresh_token}</small></p>
            <p><small><strong>Organization ID:</strong> ${orgId}</small></p>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send(`<h1>Server Error</h1><p>${error instanceof Error ? error.message : 'Unknown error'}</p>`);
  }
};

app.get('/callback', handleOAuthCallback);
app.get('/oauth/callback', handleOAuthCallback);
```

**Step 3: Modify MCP Endpoint**

```typescript
app.all('/mcp', requireApiKey, async (req: Request, res: Response) => {
  const orgId = (req.query.org_id as string) || 
                 req.header('X-Org-Id') || 
                 process.env.DEFAULT_ORG;
  
  const orgConfig = getOrgConfig(orgId);

  if (!orgConfig) {
    const availableOrgs = listEnabledOrgs();
    return res.status(404).json({
      error: 'Organization not found',
      availableOrgs: availableOrgs.map(org => org.orgId),
      authorizeUrl: `${BASE_URL}/oauth/authorize?org_id=${orgId}`
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
```

---

## Usage

### Single Org (Simple)
```env
PORT=3000
MCP_API_KEY=my-key
BASE_URL=https://salesforce-mcp.example.com
DEFAULT_ORG=org-a

ORG_A_ENABLED=true
ORG_A_NAME=My Organization
ORG_A_SF_CLIENT_ID=3MVG9F...
ORG_A_SF_CLIENT_SECRET=EF1C4D...
ORG_A_SF_API_VERSION=v65.0
```

### Multiple Orgs (Scale)
```env
# Add more ORG_* blocks for each customer

ORG_CLIENTA_ENABLED=true
ORG_CLIENTA_SF_CLIENT_ID=...
ORG_CLIENTA_SF_CLIENT_SECRET=...

ORG_CLIENTB_ENABLED=true
ORG_CLIENTB_SF_CLIENT_ID=...
ORG_CLIENTB_SF_CLIENT_SECRET=...

ORG_SANDBOX_ENABLED=true
ORG_SANDBOX_SF_CLIENT_ID=...
ORG_SANDBOX_SF_CLIENT_SECRET=...
```

---

## For CLI Integration

The CLI would:
1. Ask user for org name, client ID, client secret
2. Generate `.env` values
3. User adds to their MCPServer `.env`:
   ```env
   ORG_MYCORP_ENABLED=true
   ORG_MYCORP_NAME=My Corp
   ORG_MYCORP_SF_CLIENT_ID=user_value
   ORG_MYCORP_SF_CLIENT_SECRET=user_value
   ```
4. User calls `/oauth/authorize?org_id=org-mycorp`
5. Gets token, uses MCP

---

## Implementation Checklist

- [ ] Create `src/config.ts` for org storage/retrieval
- [ ] Create `src/setup.ts` for registration endpoint
- [ ] Modify `src/index.ts` OAuth flow to support orgId
- [ ] Modify `src/index.ts` MCP endpoint for multi-org routing
- [ ] Add database/file storage for org configs
- [ ] Add validation for Salesforce credentials
- [ ] Create migration from current single-org setup
- [ ] Update Docker build to support multi-org
- [ ] Update Kubernetes manifests for OKD deployment
- [ ] Create CLI integration code
- [ ] Document setup process for end users

---

## Files to Create/Modify

```
MCPServer/
├── src/
│   ├── index.ts              (modify for multi-org)
│   ├── config.ts             (NEW - manage org configs)
│   ├── setup.ts              (NEW - registration endpoint)
│   ├── storage.ts            (NEW - persist org data)
│   ├── validators.ts         (NEW - validate SF credentials)
│   └── types.ts              (NEW - TypeScript interfaces)
├── Dockerfile                (update env handling)
├── docker-compose.yml        (NEW - local dev with persistence)
├── k8s/
│   ├── deployment.yaml       (update for multi-org)
│   ├── configmap.yaml        (NEW - org configs)
│   └── secret.yaml           (NEW - sensitive data)
├── .env.example              (show multi-org pattern)
└── README.md                 (update setup docs)
```

---

## Next Steps

1. **Implement Option A** (multi-tenant single instance)
2. **Add file-based storage** for org configs (simpler than DB initially)
3. **Test with 2 sample orgs**
4. **Deploy to OKD**
5. **Integrate with CLI**

Would you like me to start implementing these changes?
