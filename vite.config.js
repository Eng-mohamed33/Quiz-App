import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({ plugins: [react(), VitePWA({ registerType: 'autoUpdate', manifest: { name: 'اختبر معلوماتك', short_name: 'Quiz App', start_url: '/', display: 'standalone', theme_color: '#6757e8', background_color: '#f7f8fc', lang: 'ar', dir: 'rtl' } })] });
