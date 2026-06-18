#!/usr/bin/env bats

bats_load_library 'bats-assert'
bats_load_library 'bats-support'

setup_file() {
  export STRUX="$PWD/strux"
}

@test "strux init --help displays help" {
  run "$STRUX" --verbose init --help

  assert_success
  assert_output --partial "Usage:"
  assert_output --partial "template"
  assert_output --partial "arch"
}

@test "strux init requires project name" {
  cd "$BATS_TEST_TMPDIR"
  run "$STRUX" --verbose init

  assert_failure
  assert_output --partial "error: missing required argument"
}

@test "strux init fails if directory exists" {
  cd "$BATS_TEST_TMPDIR"
  mkdir -p existing-project

  run "$STRUX" --verbose init existing-project

  assert_failure
  assert_output --partial "already exists"
}

@test "strux init creates project with default template" {
  cd "$BATS_TEST_TMPDIR"
  run "$STRUX" --verbose init my-project

  assert_success
  assert [ -d "$BATS_TEST_TMPDIR/my-project" ]
  assert [ -f "$BATS_TEST_TMPDIR/my-project/strux.yaml" ]
  assert [ -f "$BATS_TEST_TMPDIR/my-project/main.go" ]
}

@test "strux init with vanilla template" {
  cd "$BATS_TEST_TMPDIR"
  run "$STRUX" --verbose init my-project -t vanilla

  assert_success
  assert [ -d "$BATS_TEST_TMPDIR/my-project/frontend" ]
}

@test "strux init with react template" {
  cd "$BATS_TEST_TMPDIR"
  run "$STRUX" --verbose init my-project -t react

  assert_success
  assert [ -d "$BATS_TEST_TMPDIR/my-project/frontend" ]
  assert [ -f "$BATS_TEST_TMPDIR/my-project/frontend/package.json" ]
}

@test "strux init with vue template" {
  cd "$BATS_TEST_TMPDIR"
  run "$STRUX" --verbose init my-project -t vue

  assert_success
  assert [ -d "$BATS_TEST_TMPDIR/my-project/frontend" ]
  assert [ -f "$BATS_TEST_TMPDIR/my-project/frontend/package.json" ]
}

@test "strux init with invalid template fails" {
  cd "$BATS_TEST_TMPDIR"
  run "$STRUX" --verbose init my-project -t invalid

  assert_failure
  assert_output --partial "Invalid template"
}

@test "strux init with arm64 arch" {
  cd "$BATS_TEST_TMPDIR"
  run "$STRUX" --verbose init my-project -a arm64

  assert_success
  assert [ -f "$BATS_TEST_TMPDIR/my-project/bsp/qemu/bsp.yaml" ]
}

@test "strux init with x86_64 arch" {
  cd "$BATS_TEST_TMPDIR"
  run "$STRUX" --verbose init my-project -a x86_64

  assert_success
  assert [ -f "$BATS_TEST_TMPDIR/my-project/bsp/qemu/bsp.yaml" ]
}

@test "strux init with invalid arch fails" {
  cd "$BATS_TEST_TMPDIR"
  run "$STRUX" --verbose init my-project -a mips

  assert_failure
  assert_output --partial "Invalid architecture"
}