// .mxl (compressed MusicXML) 解析
// .mxl 本质是 ZIP, 内部有 META-INF/container.xml 指向真正的 MusicXML
// 用 fflate 解压 (10KB, 无依赖)
//
// 流程: bytes -> unzip -> 读 META-INF/container.xml 找 rootfile full-path
//      -> 读 rootfile (纯 XML 文本) -> 给 parseXml

import { unzipSync, strFromU8 } from 'fflate'
import { parseXml } from './parseXml'
import type { Song } from '../types'

const CONTAINER_PATH = 'META-INF/container.xml'

export function parseMxl(data: Uint8Array): Song {
  const files = unzipSync(data)

  // 1) 读 container.xml 找 rootfile
  const containerBytes = files[CONTAINER_PATH]
  if (!containerBytes) {
    throw new Error('.mxl 文件缺少 META-INF/container.xml')
  }
  const containerXml = strFromU8(containerBytes)
  const rootfileMatch = containerXml.match(
    /<rootfile[^>]*full-path=["']([^"']+)["']/,
  )
  if (!rootfileMatch) {
    throw new Error('.mxl 文件 container.xml 找不到 <rootfile>')
  }
  const rootfilePath = rootfileMatch[1]

  // 2) 读真正的 MusicXML
  const scoreBytes = files[rootfilePath]
  if (!scoreBytes) {
    throw new Error(`.mxl 文件找不到 rootfile: ${rootfilePath}`)
  }
  const scoreXml = strFromU8(scoreBytes)

  return parseXml(scoreXml)
}
