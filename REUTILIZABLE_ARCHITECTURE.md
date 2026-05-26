# MCPServer - Reutilizable Architecture Analysis

## Current State (Hardcoded)

### Environment Variables (`.env`)
```env
PORT=3000
MCP_API_KEY=una_key_larga
SF_LOGIN_URL=https://login.salesforce.com        # ❌ Mostly generic but could vary
SF_CLIENT_ID=3MVG9F...                            # ❌ HARDCODED to specific org
SF_CLIENT_SECRET=EF1C4D...                        # ❌ HARDCODED to specific org
SF_API_VERSION=v65.0
BASE_URL=https://salesforce-mcp-proxy...         # ❌ HARDCODED to specific deployment
```

### Code Issues (index.ts)
1. **Line 11:** `SF_LOGIN_URL` has fallback to hardcoded `creative-shark` org
   ```typescript
   SF_LOGIN_URL = 'https://creative-shark-mhybdo-dev-ed.trailblaze.my.salesforce.com'
   ```

2. **Lines 18-20:** Validates SF_CLIENT_ID and SF_CLIENT_SECRET are set
   - These are org-specific OAuth credentials
   - Must be generated per org

3. **Lines 96-1016:** `createMcpServer()` function
   - Already parameterized with `userToken` and `instanceUrl`
   - Good foundation, can be reused

4. **Lines 845-878:** OAuth flow
   - Uses `SF_LOGIN_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET`
   - Dynamic per request but hardcoded in env

## Solution: Multi-Tenant Architecture

### Option A: Dynamic Org Registration (Recommended)

#### Concept
- **One MCP server** can serve **multiple orgs**
- Each org registers via a setup endpoint
- Each user's request includes their org credentials in the header

#### Architecture
```
Single MCP Instance
├── /setup                    ← Organization registration
├── /oauth/authorize          ← Per-org OAuth
├── /mcp                      ← Dynamic routing based on org
└── Database/File Storage
    ├── org-1.json
    ├── org-2.json
    └── org-3.json
```

#### Implementation Steps

**Step 1: Store Org Configs**

Create a config storage system:
```typescript
interface OrgConfig {
  orgId: string;              // unique identifier
  orgName: string;            // display name
  clientId: string;           // OAuth client ID
  clientSecret: string;       // OAuth client secret
  loginUrl: string;           // usually https://login.salesforce.com
  apiVersion: string;         // v65.0, v66.0, etc
  createdAt: Date;
  active: boolean;
}
```

Storage options:
- **File-based:** `orgs/org-1.json`, `orgs/org-2.json`
- **Database:** PostgreSQL, MongoDB, Supabase
- **Environment:** Use prefix like `ORG_1_CLIENT_ID=...`

**Step 2: Create Setup Endpoint**

```typescript
app.post('/setup/register', async (req: Request, res: Response) => {
  const {
    orgName,
    clientId,
    clientSecret,
    loginUrl = 'https://login.salesforce.com',
    apiVersion = 'v65.0'
  } = req.body;

  // Validate with Salesforce
  const isValid = await validateSalesforceCredentials(clientId, clientSecret, loginUrl);
  
  if (!isValid) {
    return res.status(400).json({ error: 'Invalid Salesforce credentials' });
  }

  // Store org config
  const orgId = generateOrgId();
  await saveOrgConfig(orgId, {
    orgName,
    clientId,
    clientSecret,
    loginUrl,
    apiVersion,
    createdAt: new Date(),
    active: true
  });

  res.json({
    orgId,
    clientId,
    clientSecret,
    registeredAt: new Date(),
    oauthUrl: `${BASE_URL}/oauth/authorize?org_id=${orgId}`
  });
});
```

**Step 3: Modify OAuth Flow**

```typescript
app.get('/oauth/authorize', (req: Request, res: Response) => {
  const orgId = req.query.org_id as string;
  
  // Load org-specific config
  const orgConfig = await getOrgConfig(orgId);
  if (!orgConfig) {
    return res.status(404).json({ error: 'Org not found' });
  }

  const state = crypto.randomBytes(32).toString('hex');
  authStates.set(state, { 
    timestamp: Date.now(),
    orgId  // Store which org this is for
  });

  const authUrl = new URL(`${orgConfig.loginUrl}/services/oauth2/authorize`);
  authUrl.searchParams.set('client_id', orgConfig.clientId);
  authUrl.searchParams.set('redirect_uri', `${BASE_URL}/callback`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'full');
  authUrl.searchParams.set('state', state);

  res.redirect(authUrl.toString());
});
```

**Step 4: Modify MCP Endpoint**

```typescript
app.all('/mcp', requireApiKey, async (req: Request, res: Response) => {
  // Extract org_id from query params or use default
  const orgId = req.query.org_id as string || req.header('X-Org-Id');
  
  const orgConfig = await getOrgConfig(orgId);
  if (!orgConfig) {
    return res.status(404).json({ error: 'Org not configured' });
  }

  // Extract user token (already org-specific from OAuth)
  const auth = extractUserToken(req);
  if (!auth) {
    const authUrl = `${BASE_URL}/oauth/authorize?org_id=${orgId}`;
    return res.status(401).json({
      error: 'Missing authentication',
      authorize_url: authUrl
    });
  }

  const { token: userToken, instanceUrl } = auth;
  
  // Create MCP server with org context
  const server = createMcpServer(userToken, instanceUrl);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
});
```

### Option B: Multi-Instance Deployment (Alternative)

Each org gets its own **separate MCP container** deployed to OKD:

```
Organization A
└── MCP Pod 1 (dedicated)
    ├── Port: 3001
    └── .env (A-specific)

Organization B
└── MCP Pod 2 (dedicated)
    ├── Port: 3002
    └── .env (B-specific)

Organization C
└── MCP Pod 3 (dedicated)
    ├── Port: 3003
    └── .env (C-specific)
```

**Pros:**
- Complete isolation per org
- Easy to deploy via OKD templates

**Cons:**
- Resource overhead
- More pods to manage
- Harder to maintain

---

## Recommended: Option A (Multi-Tenant Single Instance)

### Why Option A?
1. ✅ **Resource efficient** - One container serves all orgs
2. ✅ **Easier deployment** - One OKD pod instead of many
3. ✅ **User experience** - Single URL: `https://salesforce-mcp.example.com`
4. ✅ **Maintenance** - Update once, all orgs benefit

### User Flow with Option A

```
1. Organization Admin visits: https://salesforce-mcp.example.com/setup
   └─ Registers: org name, client ID, client secret

2. System validates credentials against Salesforce

3. Org gets: orgId = "org-123-abc"
   └─ Receives registration token

4. User wants to authenticate:
   └─ Visits: https://salesforce-mcp.example.com/oauth/authorize?org_id=org-123-abc

5. After OAuth callback:
   └─ Receives: X-SF-Token header: "access_token|instance_url"

6. User calls MCP endpoint:
   └─ POST https://salesforce-mcp.example.com/mcp?org_id=org-123-abc
      Headers: 
        - Authorization: Bearer <MCP_API_KEY>
        - X-SF-Token: <access_token>|<instance_url>
        - X-Org-Id: org-123-abc

7. MCP server handles request for that specific org
```

---

## Changes Needed for CLI Integration

### Current MCPServer → CLI Integration

The CLI would:
1. Ask user for Salesforce credentials (client ID, secret)
2. Call `/setup/register` endpoint
3. Receive `orgId`
4. Generate config file with:
   - `orgId`
   - `MCP_API_KEY`
   - `MCP_BASE_URL`
5. User can then use the MCP in their IKP project

### Config File Generated by CLI

**File:** `.env.mcp` (generated by CLI in project root)
```env
SALESFORCE_ORG_ID=org-123-abc
SALESFORCE_MCP_URL=https://salesforce-mcp.example.com
SALESFORCE_MCP_API_KEY=your-key-here
SALESFORCE_API_VERSION=v65.0
```

**Or as JSON:** `.mcp.json`
```json
{
  "name": "salesforce-mcp",
  "version": "1.0.0",
  "description": "Salesforce MCP for organization XYZ",
  "orgId": "org-123-abc",
  "baseUrl": "https://salesforce-mcp.example.com",
  "apiKey": "your-key-here",
  "authUrl": "https://salesforce-mcp.example.com/oauth/authorize?org_id=org-123-abc"
}
```

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
