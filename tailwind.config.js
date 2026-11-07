/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{html,js,ts,jsx,tsx}'],
  darkMode: ['selector', '.dark'],
  theme: {
    extend: {
      colors: {
        app: 'var(--bg-app)',
        sidebar: 'var(--bg-sidebar)',
        subtle: 'var(--bg-subtle)',
        selected: 'var(--bg-selected)',
        surface: 'var(--bg-card)',
        border: 'var(--border-color)',
        'border-strong': 'var(--border-strong)',
        fg: {
          1: 'var(--text-1)',
          2: 'var(--text-2)',
          3: 'var(--text-3)'
        },
        action: {
          DEFAULT: 'var(--action-bg)',
          fg: 'var(--action-fg)',
          hover: 'var(--action-hover)',
          text: 'var(--action-text)',
          soft: 'var(--action-soft)'
        },
        direct: {
          DEFAULT: 'var(--direct-fill)',
          text: 'var(--direct-text)',
          soft: 'var(--direct-soft)',
          solid: 'var(--direct-solid)',
          border: 'var(--direct-border)'
        },
        route: {
          DEFAULT: 'var(--route-fill)',
          text: 'var(--route-text)',
          soft: 'var(--route-soft)',
          solid: 'var(--route-solid)',
          border: 'var(--route-border)'
        },
        stack: {
          DEFAULT: 'var(--stack-fill)',
          text: 'var(--stack-text)',
          soft: 'var(--stack-soft)',
          solid: 'var(--stack-solid)',
          border: 'var(--stack-border)'
        },
        success: {
          DEFAULT: 'var(--success)',
          text: 'var(--success-text)',
          soft: 'var(--success-soft)'
        },
        warning: {
          DEFAULT: 'var(--warning)',
          text: 'var(--warning-text)',
          soft: 'var(--warning-soft)'
        },
        danger: {
          DEFAULT: 'var(--danger)',
          text: 'var(--danger-text)',
          soft: 'var(--danger-soft)'
        }
      },
      borderRadius: {
        control: '6px',
        panel: '10px',
        dialog: '14px'
      },
      boxShadow: {
        'v7-sm': 'var(--shadow-sm)',
        'v7-md': 'var(--shadow-md)',
        'v7-lg': 'var(--shadow-lg)'
      }
    }
  },
  plugins: []
}
