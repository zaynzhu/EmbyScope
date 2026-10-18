import test from 'node:test'
import assert from 'node:assert/strict'
import { resourceLocations } from '../src/resources.js'

test('只保留绝对本地资源路径，去掉重复路径，远程URL和凭据不进入DTO', () => {
  const data = resourceLocations({ Path: '/mnt/电影/版本.strm', MediaSources: [
    { Path: '/mnt/电影/版本.strm' }, { Path: 'D:\\Media\\movie.mkv' }, { Path: '\\\\nas\\media\\video.mkv' },
    { Path: 'https://user:password@server/file?token=secret' }, { Path: '//user:pass@nas/share' }, { Path: '/proxy?api_key=secret' }
  ], AccessToken: 'secret' })
  assert.equal(data.locations.length, 3)
  assert.equal(data.hiddenRemote, true)
  assert.ok(!JSON.stringify(data).includes('secret'))
  assert.deepEqual(resourceLocations({}), { locations: [], hiddenRemote: false })
})

test('本地目录中的 @ 不当作认证信息，保留极影视返回的多个文件版本', () => {
  const data = resourceLocations({ Path: '/media/@collection/movie.iso', MediaSources: [
    { Path: '/media/@collection/movie.iso', Protocol: 'File', IsRemote: false },
    { Path: '/media/@collection/version-two/movie.iso', Protocol: 'File', IsRemote: false },
    { Path: 'D:\\Media\\user@example\\movie.iso' },
    { Path: '\\\\nas\\media\\@collection\\movie.iso' }
  ] })
  assert.equal(data.locations.length, 4)
  assert.equal(data.hiddenRemote, false)
  assert.equal(data.locations[0].path, '/media/@collection/movie.iso')
  const unsafe = resourceLocations({ MediaSources: [{ Path: '//user:secret@nas/share/file.iso' }, { Path: '\\\\user:secret@nas\\share\\file.iso' }] })
  assert.deepEqual(unsafe.locations, [])
  assert.equal(unsafe.hiddenRemote, true)
})
