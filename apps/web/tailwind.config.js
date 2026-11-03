/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Paleta da marca Eskimo: vermelho #B60000 (principal) e amarelo #FFCB00 (destaque sobre o vermelho).
        brand: {
          50: '#fff2f2', 100: '#ffe0e0', 200: '#ffc5c5', 300: '#ff9a9a', 400: '#f25757',
          500: '#d91c1c', 600: '#b60000', 700: '#960000', 800: '#7a0404', 900: '#630909', 950: '#3a0101',
        },
        accent: {
          50: '#fffbe6', 100: '#fff4bf', 200: '#ffe980', 300: '#ffdb40', 400: '#ffcb00',
          500: '#e6b600', 600: '#b38d00', 700: '#806500',
        },
        // Neutro escuro e quente para textos (combina com o vermelho sem competir com ele)
        ink: { 900: '#241414', 800: '#3a2020', 700: '#553333' },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
