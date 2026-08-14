{
  "targets": [
    {
      "target_name": "audiohost",
      "sources": ["src/audiohost.cc", "src/miniaudio_impl.c"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "vendor",
        "../shared"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "RELEASE=1",
        "UNICODE",
        "_UNICODE"
      ],
      "libraries": ["-lole32.lib", "-luser32.lib", "-ladvapi32.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": ["/std:c++17", "/utf-8"]
        }
      }
    }
  ]
}
