import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.nousresearch.hermes.mobile',
  appName: 'Hermes Mobile',
  webDir: 'dist',
  ios: {
    contentInset: 'never',
    preferredContentMode: 'mobile'
  },
  server: {
    androidScheme: 'https'
  }
}

export default config
