#!/usr/bin/env node
import { bumpVersion } from './version-files.mjs'

const version = process.argv[2]
if (!version || process.argv.length !== 3) {
  console.error('Usage: npm run version:bump -- <semver>')
  process.exitCode = 1
} else {
  try {
    bumpVersion(version)
    console.log(`Updated all version files to ${version}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
