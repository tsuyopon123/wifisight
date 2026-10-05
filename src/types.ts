export type Band = "2.4" | "5" | "6" | "other";

export interface IeField {
  name: string;
  value: string;
}

export interface IeView {
  id: number;
  extId: number | null;
  name: string;
  length: number;
  hex: string;
  fields: IeField[];
}

export interface Security {
  label: string;
  akms: string[];
  pairwise: string[];
  group: string | null;
  groupMgmt: string | null;
  pmf: "required" | "capable" | "disabled";
  wpa1: boolean;
  rsn: boolean;
}

export interface Features {
  rrm11k: boolean;
  ft11r: boolean;
  bssTransition11v: boolean;
  wmm: boolean;
  wps: boolean;
  passpoint: boolean;
  interworking: boolean;
  oweTransition: boolean;
  mbo: boolean;
  multipleBssid: boolean;
  multiLink: boolean;
  twtRequired: boolean;
}

export interface BssLoad {
  stationCount: number;
  channelUtilizationPct: number;
  availableAdmissionCapacity: number;
}

export interface BssInfo {
  bssid: string;
  ssid: string;
  hidden: boolean;
  vendor: string | null;
  locallyAdministered: boolean;
  apName: string | null;
  model?: string | null;
  band: Band;
  freqMhz: number;
  channel: number;
  centerChannel: number;
  centerFreqMhz: number;
  widthMhz: number;
  freqLowMhz: number;
  freqHighMhz: number;
  rssiDbm: number;
  noiseDbm: number | null;
  snrDb: number | null;
  phyModes: string[];
  generation: string;
  maxRateMbps: number | null;
  spatialStreams: number | null;
  basicRates: number[];
  supportedRates: number[];
  security: Security;
  beaconIntervalTu: number | null;
  capability: number | null;
  country: string | null;
  bssLoad: BssLoad | null;
  bssColor: number | null;
  txPowerDbm: number | null;
  features: Features;
  roamingConsortium: string[];
  vendorIes: string[];
  ies: IeView[];
  ageMs: number | null;
  connected: boolean;
  mld?: string | null;
  mldLinkId?: number | null;
}

export interface Snapshot {
  timestampMs: number;
  interface: string;
  bss: BssInfo[];
  warnings: string[];
}

export interface Interface {
  id: string;
  name: string;
  description: string;
  mac: string | null;
}

export interface PlatformInfo {
  os: string;
  arch: string;
  version: string;
  locationStatus: string | null;
  ouiEntries: number;
  installable: boolean;
}

export interface Sample {
  t: number;
  rssi: number;
}

/** A BSS tracked across scans in this session. */
export interface Track {
  info: BssInfo;
  color: string;
  history: Sample[];
  firstSeen: number;
  lastSeen: number;
  minRssi: number;
  maxRssi: number;
  hidden: boolean; // hidden from charts by the user
  mlo?: boolean; // connected as one of ≥2 links of the same AP MLD in the latest scan
}
