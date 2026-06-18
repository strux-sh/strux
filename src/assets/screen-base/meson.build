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
math = cc.find_library('m', required: false)
rt = cc.find_library('rt')  # for shm_open

# Generate screencopy protocol files
wayland_scanner = find_program('wayland-scanner')

screencopy_xml = files('protocols/wlr-screencopy-unstable-v1.xml')

screencopy_client_h = custom_target('screencopy-client-header',
  input: screencopy_xml,
  output: 'wlr-screencopy-unstable-v1-client-protocol.h',
  command: [wayland_scanner, 'client-header', '@INPUT@', '@OUTPUT@'],
)

screencopy_code = custom_target('screencopy-protocol-code',
  input: screencopy_xml,
  output: 'wlr-screencopy-unstable-v1-protocol.c',
  command: [wayland_scanner, 'private-code', '@INPUT@', '@OUTPUT@'],
)

executable(
  meson.project_name(),
  [
    'main.c',
    'capture.c',
    'pipeline.c',
    screencopy_client_h,
    screencopy_code,
  ],
  dependencies: [
    gst,
    gst_app,
    gst_video,
    wayland_client,
    math,
    rt,
  ],
  install: true,
)
