import { globalIgnores } from "eslint/config"
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript"
import pluginVue from "eslint-plugin-vue"

// To allow more languages other than `ts` in `.vue` files, uncomment the following lines:
// import { configureVueProject } from '@vue/eslint-config-typescript'
// configureVueProject({ scriptLangs: ['ts', 'tsx'] })
// More info at https://github.com/vuejs/eslint-config-typescript/#advanced-setup

export default defineConfigWithVueTs(
    {
        name: "app/files-to-lint",
        files: ["**/*.{vue,ts,mts,tsx}"],
    },

    globalIgnores(["**/dist/**", "**/dist-ssr/**", "**/coverage/**"]),

    ...pluginVue.configs["flat/essential"],
    vueTsConfigs.recommended,
    {
        rules: {
            "@typescript-eslint/interface-name-prefix": "off",
            "@typescript-eslint/explicit-function-return-type": "off",
            "@typescript-eslint/explicit-module-boundary-types": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "no-trailing-spaces": "error",
            "no-multiple-empty-lines": "error",
            "indent": ["error", 4, { "SwitchCase": 1 }],
            "linebreak-style": ["error", "unix"],
            "quotes": ["error", "double"],
            "prefer-spread": "off",
            "comma-dangle": [
                "error",
                {
                    "arrays": "only-multiline",
                    "objects": "only-multiline",
                    "imports": "never",
                    "exports": "never",
                    "functions": "never"
                }
            ],
            "@typescript-eslint/no-unused-vars": [
                "warn",
                {
                    "argsIgnorePattern": "^_",
                    "varsIgnorePattern": "^_",
                    "caughtErrorsIgnorePattern": "^_"
                }
            ],
            "semi": ["error", "never"],
            "no-unused-vars": "off",
            "object-curly-spacing": ["error", "always"],
            "vue/html-indent": ["error", 4],
            "vue/html-self-closing": "off"
        },
    }
)
