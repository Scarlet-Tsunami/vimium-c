#!/usr/bin/env node
// @ts-check
"use strict";
/** @type {import("./dependencies").FileSystem} */
// @ts-ignore
var fs = require("fs");
/** @type {import("./dependencies").ProcessType} */
// @ts-ignore
var process = require("process");
var lib = require("./dependencies");

var argv = process.argv, argi = 0, cmd = argv[0];
if (/\bnode\b/i.test(argv[argi])) {
  argi++;
}
if (/\btsc(\.\b|$)/i.test(argv[argi])) {
  argi++;
}
if (argv.indexOf("-p") < 0 && argv.indexOf("--project") < 0 && !fs.existsSync("tsconfig.json")) {
  // @ts-ignore
  var parent = __dirname.replace(/[\\\/][^\\\/]+[\\\/]?$/, "");
  if (fs.existsSync(parent + "/tsconfig.json")) {
    process.chdir(parent);
  }
}
var root = "./";
var logPrefix = "";
if (!fs.existsSync("package.json")) {
  if (fs.existsSync("../package.json")) {
    root = "../";
    logPrefix = require("path").basename(process.cwd());
  }
}

var _tscPatched = false;
var fakeArg = "--vimium-c-fake-arg";

function patchTSC() {
  if (_tscPatched) { return; }
  var path = "node_modules/typescript/lib/tsc.js";
  for (var i = 0; i < 3 && !fs.existsSync(path); ) {
    path = "../" + path;
  }
  if (i >= 3) { return; }
  var info = {};
  try {
    var code = lib.readFile(path, info).trim();
    var patched = "\n;\n\nmodule.exports = ts;\n"
          + "ts.sys.args[0] !== '" + fakeArg + "' &&\n";
    if (code.slice(-4096).indexOf(patched) < 0 && code.indexOf("module.exports = ") < 0) {
      var oldTail = "ts.executeCommandLine(ts.sys";
      var pos = code.lastIndexOf(oldTail);
      if (pos < 0) {
        throw Error("The target call is not found:");
      }
      code = code.slice(0, pos) + patched + code.slice(pos);
      fs.writeFileSync(path, code);
      console.log("Patch TypeScript/lib/tsc.js: succeed");
    }
    _tscPatched = true;
  } catch (e) {
    console.error("Error: Failed to patch TypeScript/lib/tsc.js: " + e);
  }
}

patchTSC();
if (!_tscPatched) {
  // @ts-ignore
  require("typescript/lib/tsc");
  // @ts-ignore
  return;
}

// ==================== customized building ====================

var doesUglifyLocalFiles = process.env.UGLIFY_LOCAL !== "0";
var LIB_UGLIFY_JS = 'terser';

var real_proc_exit = process.exit;
process.exit = function(){};
var real_args = argv.length > 2 ? argv.splice(2, argv.length - 2) : [];
argv.length = 2;

var real_write;
var cache = Object.create(null);

/**
 * @param {string} path
 * @param {string} data
 * @param {unknown} writeBom
 */
var writeFile = function(path, data, writeBom) {
  try {
  var isJS = path.slice(-3) === ".js";
  var srcPath = isJS ? path.slice(0, -3) + ".ts" : path;
  var same = fs.existsSync(path);
  var skip = logPrefix !== "background" && path.indexOf("background/") >= 0;
  if (!skip && cache[path] !== data) {
    if (doesUglifyLocalFiles && isJS) {
      data = getUglifyJS()(data);
      if (path.indexOf("extend_click") >= 0) {
        var patched = lib.patchExtendClick(data, true);
        data = typeof patched === "string" ? patched : patched[0] + patched[1] + patched[2];
      }
    }
    data = lib.addMetaData(path, data);
    same = same && lib.readFile(path, {}) === data;
  }
  var prefix = logPrefix && "[" + logPrefix + "]";
  prefix += " ".repeat(12 - prefix.length);
  console.log("%s %s: %s", prefix, skip ? " SKIP" : same ? "TOUCH" : "WRITE", path.replace(root, ""));
  if (same) {
    lib.touchFileIfNeeded(path, srcPath);
  } else {
    return real_write(path, data, writeBom);
  }
  }catch (ex) {
    console.log(ex);
    throw ex;
  }
};

/** @type {import("./dependencies").TerserOptions | null} */
var defaultUglifyConfig = null;
var getUglifyJS = function() {
  var uglify;
  try {
    uglify = require(LIB_UGLIFY_JS);
  } catch (e) {}
  var minify;
  if (uglify == null) {
    console.log("Can not load " + LIB_UGLIFY_JS + ", so skip uglifying");
    minify = function(data) { return data; };
  } else {
    minify = function(data, config) {
      config || (config = getDefaultUglifyConfig());
      data = uglify.minify(data, config).code;
      if (config.ecma && config.ecma >= 2017) {
        data = data.replace(/\bappendChild\b(?!`|\.call\([\w.]*doc)/g, "append");
      }
      return data;
    };
  }
  getUglifyJS = function() { return minify; };
  return minify;
};

function getDefaultUglifyConfig() {
  if (!defaultUglifyConfig) {
    defaultUglifyConfig = lib.loadUglifyConfig(root + "scripts/uglifyjs.local.json");
    var tsconfig = lib.readJSON(root + "tsconfig.json");
    var target = tsconfig.compilerOptions.target;
    defaultUglifyConfig.ecma = ({
      es5: 5, es6: 6, es2015: 6, es2017: 2017, es2018: 2018
    })[target] || defaultUglifyConfig.ecma
  }
  return defaultUglifyConfig;
}

/** @type { number | null } */
var iconsDone = null;

if (typeof module !== "undefined") {
  module.exports = {
    executeTS: executeTS,
    main: main,
  }
}
// @ts-ignore
if (typeof require === "function" && require.main === module) {
  try {
    require("./icons-to-blob").main(function (err) {
      var curIconsDone = iconsDone;
      iconsDone = err ? 1 : curIconsDone || 0;
      if (curIconsDone == null) {
        main(real_args);
      }
    });
  } catch (ex) {
    console.log("Failed to convert icons to binary data:", ex);
    if (iconsDone == null) {
      iconsDone = 2;
      main(real_args);
    }
  }
}

/** @param {string[]} args */
function main(args) {
  var useDefaultConfigFile = args.indexOf("-p") < 0 && args.indexOf("--project") < 0;
  var destDirs = [];
  for (var i = useDefaultConfigFile ? 0 : args.length; i < args.length; ) {
    var cwd = args[i];
    if (cwd[0] === "-") {
      i += cwd === "-p" || cwd === "--project" ? 2 : 1;
    } else if (/^\w+$/.test(cwd) && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) {
      destDirs.push(cwd);
      args.splice(i, 1);
    } else {
      i++;
    }
  }
  if (destDirs.length === 0 && useDefaultConfigFile && fs.existsSync("./package.json")) {
    destDirs.push("front", "background", "content", "pages");
  }
  if (destDirs.length === 0) {
    destDirs.push(".");
  }
  var child_process = require('child_process');
  /** @type Array<Promise<number>> */
  var promises = [];
  for (var i = 1; i < destDirs.length; i++) {
    promises.push(new Promise(function (resolve) {
      var child = child_process.spawn(cmd, argv.slice(1).concat(args), {
        cwd: destDirs[i],
        // @ts-ignore
        stdio: ["ignore", process.stdout, process.stderr]
      });
      child.on("close", function (code) {
        resolve(code);
      })
    }));
  }
  root = require("path").resolve(root).replace(/\\/g, "/") + "/";
  var firstTS = destDirs[0];
  if (firstTS !== ".") {
    logPrefix = firstTS;
    process.chdir(firstTS);
  }
  promises.push(executeTS(args));
  Promise.all(promises).then(function(results) {
    var err = results.reduce(function (prev, cur) { return prev || cur; }, 0);
    err && console.log("[ERROR] result code is %d", err);
    real_proc_exit(err);
  });
}

/**
 * @argument { string[] } args
 * @returns { Promise<number> }
 */
function executeTS(args) {
  return new Promise(function (resolve) {
    process.exit = function (exit_code) {
      resolve(exit_code);
    };
    try {
      _executeTS(args);
    } catch (e) {
      console.log("[ERROR] Unexpected:", e);
      resolve(-1);
    }
  });
}

/** @argument { string[] } args */
function _executeTS(args) {
  process.argv.length = 2;
  process.argv.push(fakeArg);
  // @ts-ignore
  var ts = require("typescript/lib/tsc");
  process.argv.length = 2;

  real_write = ts.sys.writeFile;
  ts.sys.writeFile = writeFile;

  if (ts.version < '3.7') {
    ts.executeCommandLine(args);
  } else if (ts.version < '3.8') {
    ts.executeCommandLine(ts.sys, {
      onCompilerHostCreate: ts.noop,
      onCompilationComplete: ts.noop,
      onSolutionBuilderHostCreate: ts.noop,
      onSolutionBuildComplete: ts.noop
    }, args);
  } else {
    ts.executeCommandLine(ts.sys, ts.noop, args);
  }
}
