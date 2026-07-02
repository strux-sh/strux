project('strux-screen', 'c',
  version: '0.1.0',
  license: 'MIT',
  meson_version: '>=0.58.1',
  default_options: [
    'c_std=c11',
    'warning_level=2',
    'werror=true',
  ],
)

add_project_arguments(
  [
    '-Wno-unused-parameter',
    '-D_POSIX_C_SOURCE=200809L',
  ],
  language: 'c',
)

cc = meson.get_compiler('c')

# Dependencies
gst = dependency('gstreamer-1.0')
gst_app = dependency('gstreamer-app-1.0')
gst_video = dependency('gstreamer-video-1.0')
wayland_client = dependency('wayland-client')
xkbcommon = dependency('xkbcommon')
math = cc.find_library('m', required: false)
rt = cc.find_library('rt')  # for shm_open

# Generate Wayland protocol files
wayland_scanner = find_program('wayland-scanner')

protocol_xmls = {
  'wlr-screencopy-unstable-v1': files('protocols/wlr-screencopy-unstable-v1.xml'),
  'wlr-virtual-pointer-unstable-v1': files('protocols/wlr-virtual-pointer-unstable-v1.xml'),
  'virtual-keyboard-unstable-v1': files('protocols/virtual-keyboard-unstable-v1.xml'),
}

protocol_sources = []
foreach name, xml : protocol_xmls
  protocol_sources += custom_target(name + '-client-header',
    input: xml,
    output: name + '-client-protocol.h',
    command: [wayland_scanner, 'client-header', '@INPUT@', '@OUTPUT@'],
  )
  protocol_sources += custom_target(name + '-protocol-code',
    input: xml,
    output: name + '-protocol.c',
    command: [wayland_scanner, 'private-code', '@INPUT@', '@OUTPUT@'],
  )
endforeach

executable(
  meson.project_name(),
  [
    'main.c',
    'capture.c',
    'input.c',
    'pipeline.c',
    protocol_sources,
  ],
  dependencies: [
    gst,
    gst_app,
    gst_video,
    wayland_client,
    xkbcommon,
    math,
    rt,
  ],
  install: true,
)
