/**
 * Constantes do protocolo USB da Mooer GE200 (modelo original).
 * Fonte: MooerManager (https://github.com/ThijsWithaar/MooerManager), GPL-2.0.
 * Veja PROTOCOL.md para o que é confirmado e o que é suposição.
 */

export const VENDOR_ID = 0x0483;
export const PRODUCT_ID = 0x5703;

/** Interface HID (classe 3) usada para controle. Confirmado (lsusb). */
export const CONTROL_INTERFACE = 3;
/** Endpoint interrupt IN (dispositivo -> host), 64 bytes. Confirmado. */
export const EP_IN = 0x81;
/** Endpoint interrupt OUT (host -> dispositivo), 64 bytes. Confirmado. */
export const EP_OUT = 0x02;
export const PACKET_SIZE = 64;

/** Preâmbulo de todo frame: bytes AA 55. */
export const SYNC0 = 0xaa;
export const SYNC1 = 0x55;

/**
 * Códigos de comando/grupo (primeiro byte do payload).
 * Nomes vêm do enum RxFrame::Group do MooerManager.
 */
export const Cmd = {
  Identify: 0x10,
  System: 0xa1,
  Volume: 0xa2,
  PedalAssignment: 0xa3,
  PatchAlternate: 0xa4, // também usado como RHYTHM no MooerManager
  PatchSetting: 0xa5,
  ActivePatch: 0xa6,
  StorePatch: 0xa8,
  ActivePatchSetting: 0xa9,
  CabinetUpload: 0xe1,
  AmpUpload: 0xe2,
  AmpModels: 0xe3,
  PatchListRequest: 0xe0,
  Menu: 0x82,
  Preset: 0x83,
  IdentifyRequest: 0x84,
  CabModels: 0x85,
  FootSwitch: 0x89,
  FX: 0x90,
  DS_OD: 0x91,
  AMP: 0x93,
  CAB: 0x94,
  NS_GATE: 0x95,
  EQ: 0x96,
  MOD: 0x97,
  DELAY: 0x98,
  REVERB: 0x99,
} as const;

/** Nome legível de um código recebido, para o log. */
export const CMD_NAMES: Record<number, string> = {
  0x10: 'Identify',
  0xa1: 'System',
  0xa2: 'Volume',
  0xa3: 'PedalAssignment',
  0xa4: 'PatchAlternate/Rhythm',
  0xa5: 'PatchSetting',
  0xa6: 'ActivePatch',
  0xa8: 'StorePatch',
  0xa9: 'ActivePatchSetting',
  0xe0: 'PatchListRequest',
  0xe1: 'CabinetUpload',
  0xe2: 'AmpUpload',
  0xe3: 'AmpModels',
  0x82: 'Menu',
  0x83: 'Preset',
  0x84: 'Identify/FW?',
  0x85: 'CabModels',
  0x89: 'FootSwitch',
  0x90: 'FX/COMP',
  0x91: 'DS/OD',
  0x93: 'AMP',
  0x94: 'CAB',
  0x95: 'NS GATE',
  0x96: 'EQ',
  0x97: 'MOD',
  0x98: 'DELAY',
  0x99: 'REVERB',
};

export const AMP_MODEL_NAMES = [
  '65 US DS', '65 US TW', '59 US BASS', 'US SONIC', 'US BLUES CL', 'US BLUES OD', 'J800', 'J900',
  'PLX100', 'E650 CL', 'E650 DS', 'POWERBELL CL', 'POWERBELL DS', 'BLACKNIGHT CL', 'BLACKNIGHT DS',
  'MARK III CL', 'MARK III DS', 'MARK V CL', 'MARK V DS', 'TRI REC CL', 'TRI REC DS', 'ROCK VRB CL',
  'ROCK VRB DS', 'CITRUS 30', 'CITRUS 50', 'SLOW 100 CR', 'SLOW 100 DS', 'DR. ZEE 18 JR', 'DR. ZEE RECK',
  'JET 100H CL', 'JET 100H OD', 'JAZZ 120', 'UK30 CL', 'UK 30 OD', 'HWT 103', 'PV 5050 CL', 'PV 5050 DS',
  'REGAL TONE CL', 'REGAL TONE OD1', 'REGAL TONE OD2', 'CAROL CL', 'CAROL OD', 'CARDEFF', 'EV 5050 CL',
  'EV 5050 DS', 'HT CLUB CL', 'HT CLUB DS', 'HUGEN CL', 'HUGEN OD', 'HUGEN DS', 'KOCHE OD', 'KOCHE DS',
  'ACOUSTIC 1', 'ACOUSTIC 2', 'ACOUSTIC 3', 'USER 1', 'USER 2', 'USER 3', 'USER 4', 'USER 5', 'USER 6',
  'USER 7', 'USER 8', 'USER 9', 'USER 10',
];

export const CAB_MODEL_NAMES = [
  'US DLX 112', 'US TWN 212', 'US BASS 410', 'Sonic 112', 'Blues 112', '1960 412', 'Eagle P412',
  'Eagle S412', 'Mark 112', 'Rec 412', 'Citrus 412', 'Citrus 212', 'Slow 412', 'Dr. Zee 112',
  'Dr. Zee 212', 'Jazz 212', 'UK 212', 'HWT 412', 'PV 5050 412', 'Regal Tone 110', 'Two Stones 212',
  'Cardeff 112', 'EV 5050 412', 'HT 412', 'Gas Station 412', 'Acoustic 112', 'User 1', 'User 2',
  'User 3', 'User 4', 'User 5', 'User 6', 'User 7', 'User 8', 'User 9', 'User 10',
];
