project('cage', 'c',
  version: '0.2.0',
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
    '-DWLR_USE_UNSTABLE',
    '-Wundef',
    '-Wno-unused-parameter',
    '-D_POSIX_C_SOURCE=200809L',
  ],
  language: 'c',
)

if get_option('buildtype').startswith('debug')
  add_project_arguments('-DDEBUG', language : 'c')
endif

cc = meson.get_compiler('c')

is_freebsd = host_machine.system().startswith('freebsd')
if is_freebsd
  add_project_arguments(
    [
      '-Wno-format-extra-args',
      '-Wno-gnu-zero-variadic-macro-arguments',
    ],
    language: 'c'
  )
endif

wlroots        = dependency('wlroots-0.18', fallback: ['wlroots', 'wlroots'])
wayland_protos = dependency('wayland-protocols', version: '>=1.14')
wayland_server = dependency('wayland-server')
wayland_client = dependency('wayland-client')
xkbcommon      = dependency('xkbcommon')
libpng         = dependency('libpng')
cairo          = dependency('cairo')
threads        = dependency('threads')
math           = cc.find_library('m')
dynamic_loader = cc.find_library('dl')

wl_protocol_dir = wayland_protos.get_variable('pkgdatadir')
wayland_scanner = find_program('wayland-scanner')
wayland_scanner_server = generator(
  wayland_scanner,
  output: '@BASENAME@-protocol.h',
  arguments: ['server-header', '@INPUT@', '@OUTPUT@'],
)
wayland_scanner_client = generator(
  wayland_scanner,
  output: '@BASENAME@-client-protocol.h',
  arguments: ['client-header', '@INPUT@', '@OUTPUT@'],
)
wayland_scanner_code = generator(
  wayland_scanner,
  output: '@BASENAME@-protocol.c',
  arguments: ['private-code', '@INPUT@', '@OUTPUT@'],
)

server_protocols = [
  [wl_protocol_dir, 'stable/xdg-shell/xdg-shell.xml'],
  ['protocols/wlr-layer-shell-unstable-v1.xml'],
]

server_protos_headers = []

foreach p : server_protocols
  xml = join_paths(p)
  server_protos_headers += wayland_scanner_server.process(xml)
endforeach

server_protos = declare_dependency(
  sources: server_protos_headers,
)

have_xwayland = wlroots.get_variable(pkgconfig: 'have_xwayland', internal: 'have_xwayland') == 'true'

version = '@0@'.format(meson.project_version())
git = find_program('git', native: true, required: false)
if git.found()
  git_commit = run_command([git, 'rev-parse', '--short', 'HEAD'], check: false)
  git_branch = run_command([git, 'rev-parse', '--abbrev-ref', 'HEAD'], check: false)
  if git_commit.returncode() == 0 and git_branch.returncode() == 0
    version = '@0@-@1@ (branch \'@2@\')'.format(
      meson.project_version(),
      git_commit.stdout().strip(),
      git_branch.stdout().strip(),
    )
  endif
endif

conf_data = configuration_data()
conf_data.set10('CAGE_HAS_XWAYLAND', have_xwayland)
conf_data.set_quoted('CAGE_VERSION', version)

scdoc = dependency('scdoc', version: '>=1.9.2', native: true, required: get_option('man-pages'))
if scdoc.found()
  scdoc_prog = find_program(scdoc.get_variable('scdoc'), native: true)
  sh = find_program('sh', native: true)
  mandir = get_option('mandir')
  man_files = [
    'cage.1.scd'
  ]
  foreach filename : man_files
    topic = filename.split('.')[-3].split('/')[-1]
    section = filename.split('.')[-2]
    output = '@0@.@1@'.format(topic, section)

    custom_target(
      output,
      input: filename,
      output: output,
      command: [
        sh, '-c', '@0@ < @INPUT@ > @1@'.format(scdoc_prog.full_path(), output)
      ],
      install: true,
      install_dir: '@0@/man@1@'.format(mandir, section)
    )
  endforeach
endif

cage_sources = [
  'cage.c',
  'idle_inhibit_v1.c',
  'layer_shell.c',
  'output.c',
  'seat.c',
  'splash.c',
  'text_input.c',
  'view.c',
  'xdg_shell.c',
]

cage_headers = [
  configure_file(input: 'config.h.in',
                 output: 'config.h',
                 configuration: conf_data),
  'idle_inhibit_v1.h',
  'layer_shell.h',
  'output.h',
  'seat.h',
  'server.h',
  'splash.h',
  'text_input.h',
  'view.h',
  'xdg_shell.h',
]

if conf_data.get('CAGE_HAS_XWAYLAND', 0) == 1
  cage_sources += 'xwayland.c'
  cage_headers += 'xwayland.h'
endif

executable(
  meson.project_name(),
  cage_sources + cage_headers,
  dependencies: [
    server_protos,
    wayland_server,
    wlroots,
    xkbcommon,
    libpng,
    math,
  ],
  install: true,
)

keyboard_protocols = [
  [wl_protocol_dir, 'stable/xdg-shell/xdg-shell.xml'],
  'protocols/wlr-layer-shell-unstable-v1.xml',
  'protocols/virtual-keyboard-unstable-v1.xml',
]
keyboard_protocol_sources = []
foreach protocol : keyboard_protocols
  protocol_path = join_paths(protocol)
  keyboard_protocol_sources += wayland_scanner_client.process(protocol_path)
  keyboard_protocol_sources += wayland_scanner_code.process(protocol_path)
endforeach

executable(
  'strux-keyboard',
  ['strux_keyboard.c', 'keyboard_icons.c'] + keyboard_protocol_sources,
  dependencies: [
    wayland_client,
    xkbcommon,
    cairo,
    threads,
    math,
    dynamic_loader,
  ],
  install: true,
)

summary = [
  '',
  'Cage @0@'.format(version),
  '',
  '    xwayland: @0@'.format(have_xwayland),
  ''
]
message('\n'.join(summary))
