#!/usr/bin/env node
import { checkVersions } from './version-files.mjs'

try {
  console.log(`Version files agree: ${checkVersions()}`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
