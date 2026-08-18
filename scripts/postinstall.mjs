#!/usr/bin/env node

/**
 * Post-install script: print configuration guide after plugin is installed.
 */

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const GREEN = '\x1b[32m'
const CYAN = '\x1b[36m'
const YELLOW = '\x1b[33m'

console.log(`
${BOLD}${GREEN}✓ tencentcloud-agentobs-sdk-dsh installed successfully!${RESET}

${BOLD}Next steps — configure CLS credentials:${RESET}

${CYAN}Option 1: Environment variables (recommended for local dev)${RESET}

  export CLS_ENDPOINT=ap-guangzhou.cls.tencentcs.com
  export CLS_TOPIC_ID=<your-topic-id>
  export CLS_SECRET_ID=<your-secret-id>
  export CLS_SECRET_KEY=<your-secret-key>

${CYAN}Option 2: Plugin config file${RESET}

  Edit ${YELLOW}~/.dsh/profiles/<profile>/cordis.patch.yml${RESET} and add:

  - id: cls-observability
    config:
      endpoint: ap-guangzhou.cls.tencentcs.com
      topicId: <your-topic-id>
      secretId: <your-secret-id>
      secretKey: <your-secret-key>

  See ${YELLOW}cordis.patch.example.yml${RESET} in this package for the full config reference.

${CYAN}Content capture: enabled by default. To disable:${RESET}

  export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false

${BOLD}${YELLOW}⚠ Important:${RESET} Please restart DSH service for the plugin to take effect:

  dsh --profile web
  dsh --profile headless
  dsh --profile harness

${BOLD}Documentation:${RESET} https://github.com/user/tencentcloud-agentobs-sdk-dsh#readme
`)
