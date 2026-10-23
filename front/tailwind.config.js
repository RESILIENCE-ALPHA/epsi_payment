/**
 * Charte EPSI Pay : thème sombre d'inspiration plateforme d'échange crypto
 * (fonds quasi noirs bleutés, cartes en relief léger, accent violet, chiffres très lisibles).
 * @type {import('tailwindcss').Config}
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Fonds et surfaces
        ink: {
          950: '#0b0a12',
          900: '#111019',
          850: '#16151f',
          800: '#1c1b27',
          700: '#272535',
          600: '#363447',
        },
        // Accent principal (boutons, liens, focus)
        brand: {
          300: '#b9a4ff',
          400: '#9b7dff',
          500: '#7b4dff',
          600: '#6a35f2',
          700: '#5926d6',
        },
        // Mouvements : crédit / débit
        gain: '#2fd28a',
        loss: '#ff5b6e',
        warn: '#ffb547',
        muted: '#8f8ca6',
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 12px 32px -12px rgba(0,0,0,0.6)',
        glow: '0 0 0 1px rgba(123,77,255,0.5), 0 8px 30px -6px rgba(123,77,255,0.45)',
      },
      borderRadius: {
        '4xl': '2rem',
      },
    },
  },
  plugins: [],
};
