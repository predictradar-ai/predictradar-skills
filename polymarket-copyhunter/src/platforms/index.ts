/**
 * CopyHunter - Platform Registry
 */

import type { Platform, PlatformAdapter } from '../core/types.js';
import { getPolymarketCLI } from './polymarket/index.js';

const adapters: Map<Platform, PlatformAdapter> = new Map();

/**
 * Get a platform adapter by name
 */
export function getPlatformAdapter(platform: Platform): PlatformAdapter {
  let adapter = adapters.get(platform);

  if (!adapter) {
    switch (platform) {
      case 'polymarket':
        adapter = getPolymarketCLI();
        break;
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
    adapters.set(platform, adapter);
  }

  return adapter;
}

/**
 * Get all supported platforms
 */
export function getSupportedPlatforms(): Platform[] {
  return ['polymarket'];
}

export * from './types.js';
export * from './polymarket/index.js';
