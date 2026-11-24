// api/ is linted by exactly web's rules (web/eslint.config.js holds the gate). ESLint 10 looks for a
// config next to each file, so this folder needs its own entry point; it adds and removes nothing.
export { default } from '../web/eslint.config.js'
