import { defaultTheme } from '@vuepress/theme-default'
import { defineUserConfig } from 'vuepress'
import { viteBundler } from '@vuepress/bundler-vite'

export default defineUserConfig({
  lang: 'en-US',

  // Base path is configurable so the same site can be published at the root
  // (latest) or under a versioned/preview subfolder. Defaults to "/" for
  // local development. The CI workflow sets DOCS_BASE per deployment target,
  // e.g. "/strux/", "/strux/v0.1.1/" or "/strux/preview/my-branch/".
  base: process.env.DOCS_BASE || '/',

  title: 'Strux OS Documentation',
  description: 'A framework for building kiosk-style Linux operating systems.',

  head: [
    ['link', { rel: 'icon', href: '/strux-icon.svg' }],
    // Absolute URL of the versions manifest used by the version switcher.
    // Set by CI; empty locally so the switcher simply hides itself.
    ['meta', { name: 'docs-versions-url', content: process.env.DOCS_VERSIONS_URL || '' }],
  ],

  theme: defaultTheme({
    logo: '/strux-white.svg',
    logoDark: '/strux-white.svg',
    colorMode: 'dark',
    colorModeSwitch: false,

    navbar: [
      { text: 'Home', link: '/' },
      { text: 'Guide', link: '/guide/introduction' },
      { text: 'Concepts', link: '/concepts/overview' },
      { text: 'BSP Development', link: '/bsp/guide/introduction' },
      { text: 'Reference', link: '/reference/cli' },
      { text: 'GitHub', link: 'https://github.com/strux-sh/strux' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          children: [
            '/guide/introduction',
            '/guide/installation',
            '/guide/getting-started',
            '/guide/project-structure',
            '/guide/frontend',
            '/guide/backend',
            '/guide/dev-mode',
            '/guide/building',
            '/guide/running-qemu',
            '/guide/flashing',
            '/guide/customizing-the-os',
            '/guide/updates',
          ],
        },
      ],
      '/concepts/': [
        {
          text: 'Concepts',
          children: [
            '/concepts/overview',
            '/concepts/build-pipeline',
            '/concepts/caching',
            '/concepts/bsp',
            '/concepts/artifacts',
            '/concepts/display-stack',
            '/concepts/update-system',
          ],
        },
      ],
      '/bsp/': [
        {
          text: 'BSP Guide',
          children: [
            '/bsp/guide/introduction',
            '/bsp/guide/writing-a-bsp',
            '/bsp/guide/kernel',
            '/bsp/guide/bootloader',
            '/bsp/guide/scripts',
            '/bsp/guide/runtime-extensions',
            '/bsp/guide/flash-scripts',
            '/bsp/guide/examples',
          ],
        },
        {
          text: 'BSP Concepts',
          children: [
            '/bsp/concepts/lifecycle-scripts',
            '/bsp/concepts/extension-system',
            '/bsp/concepts/dual-rootfs',
          ],
        },
        {
          text: 'BSP Reference',
          children: [
            '/bsp/reference/bsp-yaml',
            '/bsp/reference/build-steps',
            '/bsp/reference/environment-variables',
            '/bsp/reference/path-resolution',
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          children: [
            '/reference/cli',
            '/reference/strux-yaml',
            '/reference/go-runtime',
            '/reference/frontend-api',
          ],
        },
      ],
    },
  }),

  bundler: viteBundler(),
})
