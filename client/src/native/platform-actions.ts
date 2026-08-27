import type { HermesConnectionPlugin, NativeDownloadOptions } from '~/native/hermes-connection'
import { HermesConnection, validatedExternalURL } from '~/native/hermes-connection'

export class PlatformActions {
  constructor(private readonly connection: HermesConnectionPlugin = HermesConnection) {}

  async openExternal(rawURL: string): Promise<void> {
    const url = validatedExternalURL(rawURL)
    await this.connection.openExternal({ url: url.toString() })
  }

  async downloadAndShare(options: NativeDownloadOptions): Promise<void> {
    const file = await this.connection.download(options)
    if (file.path) await this.connection.share({ path: file.path })
  }
}
