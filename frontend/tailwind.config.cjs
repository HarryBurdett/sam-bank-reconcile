/** @type {import('tailwindcss').Config} */
module.exports = {
  // Scope to plugin frontend so the host app's Tailwind CSS doesn't leak.
  content: ['./src/**/*.{ts,tsx}'],
  // Prefix everything so we don't collide with the host's Tailwind classes.
  prefix: '',
  // Important wrapper — every utility is gated on `.bank-reconcile-app`
  // so that when the host CSS resets defaults, our component remains
  // isolated.
  important: '.bank-reconcile-app',
  theme: {
    extend: {},
  },
  plugins: [],
};
