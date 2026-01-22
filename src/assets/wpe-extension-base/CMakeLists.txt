cmake_minimum_required(VERSION 3.10)
project(strux-extension C)

find_package(PkgConfig REQUIRED)

# Core dependencies (Debian Trixie package names)
pkg_check_modules(WPE wpe-1.0 REQUIRED)
pkg_check_modules(GLIB glib-2.0 REQUIRED)
pkg_check_modules(JSON_GLIB json-glib-1.0 REQUIRED)

# libsoup - try 3.0 first (Debian Trixie default), fallback to 2.4
pkg_check_modules(SOUP libsoup-3.0)
if(NOT SOUP_FOUND)
    pkg_check_modules(SOUP libsoup-2.4 REQUIRED)
endif()

# WPE WebKit - Debian Trixie provides wpe-webkit-2.0
pkg_check_modules(WEBKIT wpe-webkit-2.0)
if(NOT WEBKIT_FOUND)
    message(STATUS "wpe-webkit-2.0 not found, trying wpe-webkit-1.1")
    pkg_check_modules(WEBKIT wpe-webkit-1.1)
endif()
if(NOT WEBKIT_FOUND)
    message(STATUS "wpe-webkit-1.1 not found, trying wpe-webkit-1.0")
    pkg_check_modules(WEBKIT wpe-webkit-1.0)
endif()
if(NOT WEBKIT_FOUND)
    message(FATAL_ERROR "Could not find WPE WebKit development files")
endif()

# JavaScriptCore (usually bundled with WebKit)
pkg_check_modules(JSC javascriptcoregtk-4.1)
if(NOT JSC_FOUND)
    pkg_check_modules(JSC javascriptcoregtk-4.0)
endif()
# JSC is optional - some builds bundle it with WebKit

add_library(strux-extension SHARED extension.c)

target_include_directories(strux-extension PRIVATE
    ${WPE_INCLUDE_DIRS}
    ${WEBKIT_INCLUDE_DIRS}
    ${GLIB_INCLUDE_DIRS}
    ${JSON_GLIB_INCLUDE_DIRS}
    ${SOUP_INCLUDE_DIRS}
    ${JSC_INCLUDE_DIRS}
)

target_link_libraries(strux-extension PRIVATE
    ${WPE_LIBRARIES}
    ${WEBKIT_LIBRARIES}
    ${GLIB_LIBRARIES}
    ${JSON_GLIB_LIBRARIES}
    ${SOUP_LIBRARIES}
    ${JSC_LIBRARIES}
)

install(TARGETS strux-extension DESTINATION lib)
