import { defineClientConfig } from 'vuepress/client'
import { h, onMounted, ref } from 'vue'

// Floating version switcher. It reads a `versions.json` manifest (whose URL is
// injected via a <meta name="docs-versions-url"> tag by the build) and lets the
// reader jump between the latest docs, tagged releases and branch previews.
// When the manifest is missing (e.g. local dev) the widget renders nothing.
const VersionSwitcher = {
  setup() {
    const options = ref([])
    const currentPath = ref('')

    onMounted(async () => {
      const meta = document.querySelector('meta[name="docs-versions-url"]')
      const url = meta && meta.getAttribute('content')
      if (!url) return

      try {
        const res = await fetch(url, { cache: 'no-cache' })
        if (!res.ok) return
        const data = await res.json()

        const rootPath = url.slice(0, url.lastIndexOf('/') + 1)
        const items = [{ label: `latest${data.latest ? ` (v${data.latest})` : ''}`, path: rootPath }]

        for (const r of data.releases || []) {
            items.push({ label: `v${r.version}`, path: r.path })
        }
        for (const p of data.previews || []) {
            items.push({ label: `preview: ${p.branch}`, path: p.path })
        }

        options.value = items

        const here = window.location.pathname
        const match = items
            .filter((i) => here.startsWith(i.path))
            .sort((a, b) => b.path.length - a.path.length)[0]
        currentPath.value = match ? match.path : rootPath
      } catch {
        // Manifest unreachable or malformed: leave the switcher hidden.
      }
    })

    return () => {
      if (options.value.length <= 1) return null

      return h(
        'div',
        { class: 'strux-version-switcher' },
        [
          h('span', { class: 'strux-version-switcher__label' }, 'Version'),
          h(
            'select',
            {
              class: 'strux-version-switcher__select',
              value: currentPath.value,
              onChange: (e) => {
                const path = e.target.value
                if (path && path !== currentPath.value) window.location.href = path
              },
            },
            options.value.map((o) => h('option', { value: o.path }, o.label)),
          ),
        ],
      )
    }
  },
}

export default defineClientConfig({
  rootComponents: [VersionSwitcher],
})
