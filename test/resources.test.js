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
