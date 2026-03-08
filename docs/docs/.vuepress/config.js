import { defaultTheme } from '@vuepress/theme-default'
import { defineUserConfig } from 'vuepress'
import { viteBundler } from '@vuepress/bundler-vite'

export default defineUserConfig({
  lang: 'en-US',

  title: 'Strux OS Documentation',
  description: 'A framework for building kiosk-style Linux operating systems.',

  head: [
    ['link', { rel: 'icon', href: '/strux-icon.svg' }],
  ],

  theme: defaultTheme({
    logo: '/strux-white.svg',
    logoDark: '/strux-white.svg',
    colorMode: 'dark',
    colorModeSwitch: false,

    navbar: [
      { text: 'Home', link: '/' },
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Concepts', link: '/concepts/overview' },
      { text: 'Reference', link: '/reference/cli' },
      { text: 'GitHub', link: 'https://github.com/strux-sh/strux' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          children: [
            '/guide/getting-started',
            '/guide/installation',
            '/guide/project-structure',
            '/guide/building',
            '/guide/dev-mode',
          ],
        },
      ],
      '/concepts/': [
        {
          text: 'Concepts',
          children: [
            '/concepts/overview',
            '/concepts/architecture',
            '/concepts/build-pipeline',
            '/concepts/bsp',
            '/concepts/lifecycle-scripts',
            '/concepts/packages',
            '/concepts/caching',
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          children: [
            '/reference/cli',
            '/reference/strux-yaml',
            '/reference/bsp-yaml',
            '/reference/go-runtime',
            '/reference/typescript-types',
            '/reference/environment-variables',
          ],
        },
      ],
    },
  }),

  bundler: viteBundler(),
})
