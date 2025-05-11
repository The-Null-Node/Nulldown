import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';

export default {
  plugins: {
    "@tailwindcss/postcss": {}, // Instead of 'tailwindcss'
    autoprefixer: {},
  }
}