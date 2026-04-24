(function (g) {
  if (g.__ttsDebugHelpersLoaded) return;
  g.__ttsDebugHelpersLoaded = true;

  var ttsDebug = false;
  if (g.chrome && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get({ ttsDebug: false }, function (r) {
      ttsDebug = r.ttsDebug;
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === "local" && changes.ttsDebug) ttsDebug = changes.ttsDebug.newValue;
    });
  }

  g.__ttsCreateTtsLog = function (prefix) {
    return function () {
      if (!ttsDebug) return;
      var a = [].slice.call(arguments);
      console.log.apply(console, ["[TTS " + prefix + "]"].concat(a));
    };
  };
})(typeof self !== "undefined" ? self : this);
