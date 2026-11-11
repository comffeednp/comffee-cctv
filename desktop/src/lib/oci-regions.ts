/**
 * Oracle Cloud commercial regions (realm oc1, domain oraclecloud.com), from the OCI SDK region table.
 * Singapore comes first; the rest are sorted by their label.
 */

export interface OciRegion {
  /** Region identifier, for example "ap-singapore-1". */
  name: string;
  /** Place name shown to people. */
  label: string;
}

const LABELS: Record<string, string> = {
  'ap-singapore-1': 'Singapore',
  'ap-singapore-2': 'Singapore West',
  'af-casablanca-1': 'Casablanca',
  'af-johannesburg-1': 'Johannesburg',
  'ap-batam-1': 'Batam',
  'ap-chuncheon-1': 'Chuncheon',
  'ap-delhi-1': 'Delhi',
  'ap-hyderabad-1': 'Hyderabad',
  'ap-kulai-2': 'Kulai',
  'ap-melbourne-1': 'Melbourne',
  'ap-mumbai-1': 'Mumbai',
  'ap-osaka-1': 'Osaka',
  'ap-seoul-1': 'Seoul',
  'ap-sydney-1': 'Sydney',
  'ap-tokyo-1': 'Tokyo',
  'ca-montreal-1': 'Montreal',
  'ca-toronto-1': 'Toronto',
  'eu-amsterdam-1': 'Amsterdam',
  'eu-frankfurt-1': 'Frankfurt',
  'eu-madrid-1': 'Madrid',
  'eu-madrid-3': 'Madrid 3',
  'eu-marseille-1': 'Marseille',
  'eu-milan-1': 'Milan',
  'eu-paris-1': 'Paris',
  'eu-stockholm-1': 'Stockholm',
  'eu-turin-1': 'Turin',
  'eu-zurich-1': 'Zurich',
  'il-jerusalem-1': 'Jerusalem',
  'me-abudhabi-1': 'Abu Dhabi',
  'me-dubai-1': 'Dubai',
  'me-jeddah-1': 'Jeddah',
  'me-riyadh-1': 'Riyadh',
  'mx-monterrey-1': 'Monterrey',
  'mx-queretaro-1': 'Queretaro',
  'sa-bogota-1': 'Bogota',
  'sa-santiago-1': 'Santiago',
  'sa-saopaulo-1': 'Sao Paulo',
  'sa-valparaiso-1': 'Valparaiso',
  'sa-vinhedo-1': 'Vinhedo',
  'uk-cardiff-1': 'Cardiff',
  'uk-london-1': 'London',
  'us-ashburn-1': 'Ashburn',
  'us-chicago-1': 'Chicago',
  'us-phoenix-1': 'Phoenix',
  'us-saltlake-2': 'Salt Lake City',
  'us-sanjose-1': 'San Jose',
};

export const DEFAULT_REGION = 'ap-singapore-1';

export const OCI_REGIONS: readonly OciRegion[] = (() => {
  const all = Object.entries(LABELS).map(([name, label]) => ({ name, label }));
  const first = all.filter((r) => r.name === DEFAULT_REGION);
  const rest = all.filter((r) => r.name !== DEFAULT_REGION).sort((a, b) => a.label.localeCompare(b.label));
  return [...first, ...rest];
})();

export function isOciRegion(value: unknown): value is string {
  return typeof value === 'string' && Object.hasOwn(LABELS, value);
}

export function regionLabel(name: string): string {
  return LABELS[name] ?? name;
}

/** Second-level domain of realm oc1. Every region above is in it. */
export const OCI_DOMAIN = 'oraclecloud.com';

/** Service endpoint, for example https://iaas.ap-singapore-1.oraclecloud.com. Only for regions in the list. */
export function serviceEndpoint(service: 'identity' | 'iaas' | 'auth' | 'login', region: string): string {
  if (!isOciRegion(region)) throw new Error(`Unknown Oracle region: ${region}`);
  return `https://${service}.${region}.${OCI_DOMAIN}`;
}
