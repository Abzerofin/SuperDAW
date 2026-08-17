{
  "targets": [
    {
      "target_name": "claphost",
      "sources": ["src/claphost.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "../clap/include"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "UNICODE", "_UNICODE"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": ["/std:c++17", "/utf-8"]
        }
      }
    }
  ]
}
