export interface OrgConfig {
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

  // Parse environment variables by known field names
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('ORG_')) continue;

    // Extract org ID and field by matching known field patterns
    let orgId: string | null = null;
    let fieldValue: any = null;
    let fieldName: string = '';

    if (key.endsWith('_NAME')) {
      orgId = key.slice(4, -5).toLowerCase(); // ORG_{ID}_NAME
      fieldName = 'NAME';
      fieldValue = value || '';
    } else if (key.endsWith('_ENABLED')) {
      orgId = key.slice(4, -8).toLowerCase(); // ORG_{ID}_ENABLED
      fieldName = 'ENABLED';
      fieldValue = value === 'true';
    } else if (key.endsWith('_SF_LOGIN_URL')) {
      orgId = key.slice(4, -13).toLowerCase(); // ORG_{ID}_SF_LOGIN_URL
      fieldName = 'SF_LOGIN_URL';
      fieldValue = value || 'https://login.salesforce.com';
    } else if (key.endsWith('_SF_CLIENT_ID')) {
      orgId = key.slice(4, -13).toLowerCase(); // ORG_{ID}_SF_CLIENT_ID
      fieldName = 'SF_CLIENT_ID';
      fieldValue = value || '';
    } else if (key.endsWith('_SF_CLIENT_SECRET')) {
      orgId = key.slice(4, -17).toLowerCase(); // ORG_{ID}_SF_CLIENT_SECRET
      fieldName = 'SF_CLIENT_SECRET';
      fieldValue = value || '';
    } else if (key.endsWith('_SF_API_VERSION')) {
      orgId = key.slice(4, -15).toLowerCase(); // ORG_{ID}_SF_API_VERSION
      fieldName = 'SF_API_VERSION';
      fieldValue = value || 'v65.0';
    }

    if (!orgId || !fieldName) continue;

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

    switch (fieldName) {
      case 'NAME':
        org.name = fieldValue;
        break;
      case 'ENABLED':
        org.enabled = fieldValue;
        break;
      case 'SF_LOGIN_URL':
        org.loginUrl = fieldValue;
        break;
      case 'SF_CLIENT_ID':
        org.clientId = fieldValue;
        break;
      case 'SF_CLIENT_SECRET':
        org.clientSecret = fieldValue;
        break;
      case 'SF_API_VERSION':
        org.apiVersion = fieldValue;
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

export function getDefaultOrgId(): string | null {
  return process.env.DEFAULT_ORG || null;
}
