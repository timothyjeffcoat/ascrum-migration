// api/ is linted by web's rules (web/eslint.config.js holds the gate). ESLint 10 looks for a config next
// to each file, so this folder needs its own entry point. It removes nothing and adds one rule: no
// import() in api/src (DEV-p5-containers-11, SERVER_SOURCE_RULES), as for web/stub.
import webConfig, { SERVER_SOURCE_RULES } from '../web/eslint.config.js'

export default [...webConfig, { files: ['src/**/*.ts'], rules: SERVER_SOURCE_RULES }]
