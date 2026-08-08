{
  "targets": [
    {
      "target_name": "vst3host",
      "sources": [
        "src/vst3host.cc",
        "../vst3sdk/public.sdk/source/vst/hosting/module.cpp",
        "../vst3sdk/public.sdk/source/vst/hosting/module_win32.cpp",
        "../vst3sdk/public.sdk/source/vst/hosting/hostclasses.cpp",
        "../vst3sdk/public.sdk/source/vst/hosting/pluginterfacesupport.cpp",
        "../vst3sdk/public.sdk/source/vst/hosting/parameterchanges.cpp",
        "../vst3sdk/public.sdk/source/vst/utility/stringconvert.cpp",
        "../vst3sdk/public.sdk/source/common/commonstringconvert.cpp",
        "../vst3sdk/public.sdk/source/common/memorystream.cpp",
        "../vst3sdk/public.sdk/source/common/commoniids.cpp",
        "../vst3sdk/public.sdk/source/vst/vstinitiids.cpp",
        "../vst3sdk/pluginterfaces/base/conststringtable.cpp",
        "../vst3sdk/pluginterfaces/base/coreiids.cpp",
        "../vst3sdk/pluginterfaces/base/funknown.cpp",
        "../vst3sdk/pluginterfaces/base/ustring.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "../vst3sdk"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "RELEASE=1",
        "UNICODE",
        "_UNICODE"
      ],
      "libraries": ["-lole32.lib", "-lshell32.lib", "-luser32.lib", "-lgdi32.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": ["/std:c++17", "/utf-8"]
        }
      }
    }
  ]
}
