/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {classes: Cc, interfaces: Ci, utils: Cu, manager: Cm} = Components;

Cu.import("resource://gre/modules/AppConstants.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/Preferences.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

const XMLHttpRequest = Components.Constructor("@mozilla.org/xmlextras/xmlhttprequest;1");

XPCOMUtils.defineLazyModuleGetter(this, "OS", "resource://gre/modules/osfile.jsm");

Cu.importGlobalProperties(["TextDecoder"]);

const PREF_CLIENT_ID = "asanreporter.clientid";
const PREF_API_URL = "asanreporter.apiurl";
const PREF_AUTH_TOKEN = "asanreporter.authtoken";

function log(aMsg) {
  console.log("@ ASan Reporter: " + aMsg);
}

function install(aData, aReason) {}

function uninstall(aData, aReason) {}

function startup(aData, aReason) {
  log("startup");
  // We could use OS.Constants.Path.tmpDir here, but unfortunately there is
  // no way in C++ to get the same value *prior* to xpcom initialization.
  // Since ASan needs its options, including the "log_path" option already
  // at early startup, there is no way to pass this on to ASan.
  //
  // Instead, we hardcode the /tmp directory here, which should be fine in
  // most cases, as long as we are on Linux and Mac (the main targets for
  // this addon at the time of writing).
  processDirectory("/tmp");
}

function shutdown(aData, aReason) {
  log("shutdown");
}

function processDirectory(pathString) {
  let iterator = new OS.File.DirectoryIterator(pathString);
  let results = [];

  // Scan the directory for any ASan logs that we haven't
  // submitted yet. Store the filenames in an array so we
  // can close the iterator early.
  iterator.forEach(
    (entry) => {
      if (entry.name.indexOf("ff_asan_log.") == 0
        && entry.name.indexOf("submitted") < 0) {
        results.push(entry);
      }
    }
  ).then(
    () => {
      iterator.close();

      log("Processing " + results.length + " reports...")

      if (results.length > 0) {
        // Submit the first report ...
        let promise = submitReport(results[0].path);

        // ... then chain all other report submit calls
        for (let i = 1; i < results.length; ++i) {
          let f = function() { return submitReport(results[i].path) }
          promise = promise.then(f,f);
        }
      }
    },
    (e) => {
      iterator.close();
      log("Error: " + e);
    }
  );
}

function submitReport(reportFile) {
  log("Processing " + reportFile);
  return OS.File.read(reportFile).then(submitToServer).then(
    () => {
      // Mark as submitted only if we successfully submitted it to the server.
      return OS.File.move(reportFile, reportFile + ".submitted")
    }
  );
}

function submitToServer(data) {
  return new Promise(function (resolve, reject) {
      log("Setting up XHR request");
      let cid = Preferences.get(PREF_CLIENT_ID);
      let api_url = Preferences.get(PREF_API_URL);
      let auth_token = Preferences.get(PREF_AUTH_TOKEN);

      let decoder = new TextDecoder();

      if (!cid) {
        cid = "unknown";
      }

      let versionArr = [
        Services.appinfo.version,
        Services.appinfo.appBuildID,
        (AppConstants.SOURCE_REVISION_URL || "unknown")
      ]

      // Concatenate all relevant information as our server only
      // has one field available for version information.
      let version = versionArr.join("-");
      let os = AppConstants.platform;

      let reportObj = {
        rawStdout: "",
        rawStderr: "",
        rawCrashData: decoder.decode(data),
        // Hardcode platform as there is no other reasonable platform for ASan
        platform: "x86-64",
        product: "mozilla-central-asan-nightly",
        product_version: version,
        os: os,
        client: cid,
        tool: "asan-nightly-program"
      }

      var xhr = new XMLHttpRequest();
      xhr.open('POST', api_url, true);
      xhr.setRequestHeader("Content-Type", "application/json");

      // For internal testing purposes, an auth_token can be specified
      if (auth_token) {
        xhr.setRequestHeader("Authorization", "Token " + auth_token);
      }

      xhr.onreadystatechange = function () {
        if (xhr.readyState == 4) {
          if (xhr.status == "201") {
            log("XHR: OK");
            resolve(xhr);
          } else {
            log("XHR: Status: " + xhr.status + " Response: " + xhr.responseText);
            reject(xhr);
          }
        }
      };

      xhr.send(JSON.stringify(reportObj));
  });
}
