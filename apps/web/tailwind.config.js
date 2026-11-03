/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Identidade própria do Eskimo Smart Gestão: azul-gelo sobre marinho.
        brand: {
          50: '#eef7ff', 100: '#d8ecff', 200: '#b9ddff', 300: '#89c8ff', 400: '#52a9ff',
          500: '#2a86f5', 600: '#1468e0', 700: '#1253b5', 800: '#15478f', 900: '#173e75', 950: '#0f2448',
        },
        ink: { 900: '#0b1526', 800: '#13213a', 700: '#1d2e4d' },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
