{
  provider = "redtruck";
  baseUrl = "https://llm.mist-gamma.ts.net:8443/v1";

  models = {
    "Qwen3.8-27B-NVFP4" = {
      displayName = "Qwen3.8 27B NVFP4 (redtruck)";

      reasoning = true;
      headroom = 4096;
      maxTokens = 32768;
      thinkingLevels = {
        minimal = "medium";
        low = "medium";
        medium = "medium";
        high = "xhigh";
        xhigh = "xhigh";
        max = "xhigh";
      };
      vision = {
        maxImages = 3;
      };

      ninfer = {
        artifact = {
          repo = "neroued/Qwen3.8-27B-nvfp4-NInfer";
          revision = "f0b43ad436b9fa8142c6ed6647c470a6fe409484";
          file = "qwen3_8_27b_nvfp4.ninfer";
          hash = "sha256-dNLFcUXm/xHR0vqnlZRHf5vJA6YRrx+yAhgYn7u3fYI=";
        };
        maxContext = 225280;
        maxConcurrency = 4;
        kvDtype = "k8v4";
        prefillChunk = 2048;
        spec = "dflash2";
        draftTokens = 7;
        proposalHead = "optimized";
        hostCacheMib = 26624;
        pendingTimeoutMs = 600000;
        defaultMaxTokens = 8192;
        vision = true;
        extraArgs = [ ];
      };
    };
  };

  enabled = [ "Qwen3.8-27B-NVFP4" ];
  default = "Qwen3.8-27B-NVFP4";
}
