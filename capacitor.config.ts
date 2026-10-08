import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.pi.mobile',
  appName: 'Piop',
  webDir: 'dist-mobile',
  server: { androidScheme: 'https' },
  android: { path: 'clients/android', backgroundColor: '#181817', allowMixedContent: false },
};

export default config;
