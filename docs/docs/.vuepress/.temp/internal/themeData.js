export const themeData = JSON.parse("{\"logo\":\"/strux-white.svg\",\"logoDark\":\"/strux-white.svg\",\"colorMode\":\"dark\",\"colorModeSwitch\":false,\"navbar\":[{\"text\":\"Home\",\"link\":\"/\"},{\"text\":\"Guide\",\"link\":\"/guide/getting-started\"},{\"text\":\"Concepts\",\"link\":\"/concepts/overview\"},{\"text\":\"Reference\",\"link\":\"/reference/cli\"},{\"text\":\"GitHub\",\"link\":\"https://github.com/strux-sh/strux\"}],\"sidebar\":{\"/guide/\":[{\"text\":\"Guide\",\"children\":[\"/guide/getting-started\",\"/guide/installation\",\"/guide/project-structure\",\"/guide/building\",\"/guide/dev-mode\"]}],\"/concepts/\":[{\"text\":\"Concepts\",\"children\":[\"/concepts/overview\",\"/concepts/architecture\",\"/concepts/build-pipeline\",\"/concepts/bsp\",\"/concepts/lifecycle-scripts\",\"/concepts/packages\",\"/concepts/caching\"]}],\"/reference/\":[{\"text\":\"Reference\",\"children\":[\"/reference/cli\",\"/reference/strux-yaml\",\"/reference/bsp-yaml\",\"/reference/go-runtime\",\"/reference/typescript-types\",\"/reference/environment-variables\"]}]},\"locales\":{\"/\":{\"selectLanguageName\":\"English\"}},\"repo\":null,\"selectLanguageText\":\"Languages\",\"selectLanguageAriaLabel\":\"Select language\",\"sidebarDepth\":2,\"editLink\":true,\"editLinkText\":\"Edit this page\",\"lastUpdated\":true,\"contributors\":true,\"contributorsText\":\"Contributors\",\"notFound\":[\"There's nothing here.\",\"How did we get here?\",\"That's a Four-Oh-Four.\",\"Looks like we've got some broken links.\"],\"backToHome\":\"Take me home\",\"openInNewWindow\":\"open in new window\",\"toggleColorMode\":\"toggle color mode\",\"toggleSidebar\":\"toggle sidebar\"}")

if (import.meta.webpackHot) {
  import.meta.webpackHot.accept()
  if (__VUE_HMR_RUNTIME__.updateThemeData) {
    __VUE_HMR_RUNTIME__.updateThemeData(themeData)
  }
}

if (import.meta.hot) {
  import.meta.hot.accept(({ themeData }) => {
    __VUE_HMR_RUNTIME__.updateThemeData(themeData)
  })
}
