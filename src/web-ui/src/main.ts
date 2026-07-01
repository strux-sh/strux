import "./assets/main.css"
import "@strux-sh/ui/dist.css"
import "@strux-sh/ui/fonts"

import { createApp } from "vue"
import { createPinia } from "pinia"

import App from "./App.vue"
import router from "./router"

const app = createApp(App)

app.use(createPinia())
app.use(router)

app.mount("#app")
