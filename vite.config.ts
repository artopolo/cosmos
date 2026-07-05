import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './', // relative assets: works at github.io/<repo>/ and anywhere else
  server: {
    host: true, // reachable from the iPad on the local network
  },
})
