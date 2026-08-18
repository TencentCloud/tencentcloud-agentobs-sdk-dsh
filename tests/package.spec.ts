import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'
import { VERSION } from '../src/version.js'

describe('DSH bundle contract', () => {
  it('exports the named function-plugin shape without a default export', () => {
    expect(plugin.name).toBe('cls-observability')
    expect(plugin.inject).toEqual(['sessions', 'llm'])
    expect(plugin.Config).toBeDefined()
    expect(plugin.apply).toEqual(expect.any(Function))
    expect(plugin).not.toHaveProperty('default')
  })

  it('declares an installable dsh.bundle and matching patch row', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(manifest.version).toBe(VERSION)
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toHaveProperty('tencentcloud-cls-sdk-js')
    expect(patch).toContain('id: cls-observability')
    expect(patch).toContain("name: 'tencentcloud-agentobs-sdk-dsh'")
  })
})
