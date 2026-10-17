import { defineConfig } from 'tsdown';

export default defineConfig({ entry: ['src/channel.ts'], format: ['esm'], dts: true, clean: true });
