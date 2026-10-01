import { defaultTheme } from '@vuepress/theme-default'
import { defineUserConfig } from 'vuepress'
import { viteBundler } from '@vuepress/bundler-vite'
import { describePage, llmsTxtPlugin } from './seo.js'

// The docs are served at docs.strux.sh. CI sets DOCS_CHANNEL for each build: "latest" is the root site that search
// engines index; "release" snapshots (/vX.Y.Z/) and branch "preview" builds ask not to be indexed, so they never
// compete with the current docs in search results.
const hostname = process.env.DOCS_HOSTNAME || 'https://docs.strux.sh'
const indexable = (process.env.DOCS_CHANNEL || 'latest') === 'latest'

const title = 'Strux OS Documentation'
const description = 'Build a bootable kiosk Linux image from a web frontend and a Go backend, develop on real hardware, write board support packages, and ship signed updates.'

// One share card for every page, so links never preview a diagram or an SVG that social sites cannot show.
const shareImage = `${hostname}/og-image.png`

const publisher = { '@type': 'Organization', name: 'Medeiros IT Consulting', url: 'https://medeirosit.com' }

export default defineUserConfig({
  lang: 'en-US',

  // Base path is configurable so the same site can be published at the root
  // (latest) or under a versioned/preview subfolder. Defaults to "/" for
  // local development. The CI workflow sets DOCS_BASE per deployment target,
  // e.g. "/strux/", "/strux/v0.1.1/" or "/strux/preview/my-branch/".
  base: process.env.DOCS_BASE || '/',

  title,
  description,

  head: [
    ['link', { rel: 'icon', href: '/strux-icon.svg' }],
    // Absolute URL of the versions manifest used by the version switcher.
    // Set by CI; empty locally so the switcher simply hides itself.
    ['meta', { name: 'docs-versions-url', content: process.env.DOCS_VERSIONS_URL || '' }],
    ...(indexable ? [] : [['meta', { name: 'robots', content: 'noindex, follow' }]]),
  ],

  extendsPage: (page) => describePage(page, description),

  plugins: indexable ? [llmsTxtPlugin({ hostname, title, description })] : [],

  theme: defaultTheme({
    // Setting the hostname turns on the theme's SEO (canonical, Open Graph, JSON-LD) and sitemap plugins.
    hostname,

    themePlugins: {
      seo: {
        autoDescription: false,
        canonical: (page) => (indexable ? `${hostname}${page.path}` : null),
        author: { name: 'Medeiros IT Consulting', url: 'https://medeirosit.com' },
        ogp: (ogp) => ({ ...ogp, 'og:image': shareImage, 'og:image:alt': 'Strux OS Documentation', 'twitter:card': 'summary_large_image' }),
        // Structured data names the company as author and publisher, and omits the modified date when git has none.
        jsonLd: ({ dateModified, ...jsonLd }) => ({ ...jsonLd, ...(dateModified ? { dateModified } : {}), image: [shareImage], author: [publisher], publisher }),
      },
      sitemap: indexable,
    },

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
      { text: 'strux.sh', link: 'https://strux.sh' },
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
