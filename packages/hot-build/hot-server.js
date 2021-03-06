// Never run as a server package (only as a build plugin)
if (process.env.APP_ID)
  return;

// Don't do anything real in these circumstances
if (process.env.INSIDE_ACCELERATOR
    || process.env.NODE_ENV !== 'development'
    || process.argv.indexOf('test') !== -1
    || process.argv.indexOf('test-packages') !== -1) {

  Hot = function() {};
  Hot.prototype.wrap = function(compiler) { return compiler; }
  return;
}

var path = Npm.require('path');
var fs = Npm.require('fs');

// XXX better way to do this?
var tmp = null;
projRoot = process.cwd();

while (projRoot !== tmp && !fs.existsSync(path.join(projRoot, '.meteor'))) {
  tmp = projRoot;  // used to detect drive root on windows too ("./.." == ".")
  projRoot = path.normalize(path.join(projRoot, '..'));
}

if (projRoot === tmp) {
  // We stop processing this file here in a non-devel environment
  // because a production build won't have a .meteor directory.
  // We need it during the build process (which is also "production"),
  // but for now we assume that this kind of error would be detected
  // during development.  Would love to hear of alternative ways to do
  // this.  Could maybe check for "local/star.json" to identify devel build.
  if (process.env.NODE_ENV !== 'development')
    return;
  else
    throw new Error("Are you running inside a Meteor project dir?");
}

var pkgConfig = packageJson.getPackageConfig('gadicc:hot-build', false
  /*
    we can do this eventually, but need a way to disable a plugin in the
    accelerator
  function (prev, next) {
    if (JSON.stringify(prev.enabled) !== JSON.stringify(next.enabled)) {
      enabled = next.enabled;
      Hot.setEnabledStatuses();
    }

    return true;
  }
  */
);
var enabled = pkgConfig.enabled;

function loadVersions() {
  var versionsRaw = fs.readFileSync(
    path.join(projRoot, '.meteor', 'versions'), 'utf8'
  ).split('\n');

  var versions = {};
  for (var i=0; i < versionsRaw.length; i++) {
    var line = versionsRaw[i].split('@');
    if (line.length == 2)
      versions[line[0]] = line[1];
  }
  return versions;  
}

var METEOR_HOME;
if (process.platform === "win32")
  METEOR_HOME = process.env.METEOR_INSTALLATION;
else
  METEOR_HOME = path.join(process.env.HOME, '.meteor');

var versions = null;

function findPackagePath(name) {
  var p = path.join(projRoot, '.meteor', 'local',
    'isopacks', name.replace(':', '_'));

  // First look for a locally installed version of the package (e.g. devel)
  if (fs.existsSync(p)) {
    return p;
  }

  if (!versions)
    versions = loadVersions();
  var version = versions[name];

  return path.join(METEOR_HOME, 'packages', name.replace(/:/,'_'), version);
}

function getPluginPath(name) {
  var parts = name.split('/');
  var packageName = parts[0];
  var pluginName = parts[1];

  var packagePath = findPackagePath(packageName);
  if (!packagePath)
    return null;

  var isopack = JSON.parse(
    fs.readFileSync(path.join(packagePath, 'isopack.json'))
  )['isopack-2'];

  if (!isopack)
    throw new Error("[gadicc:hot] No isopack-2 section: " + packageName);
  if (isopack.plugins.length === 0)
    throw new Error("[gadicc:hot] No plugins found in " + name);

  var plugin = _.find(isopack.plugins, function(plugin) {
    return plugin.name === pluginName;
  });

  if (!plugin)
    throw new Error("[gadicc:hot] No plugin \"" + pluginName
      + "\" in package \"" + packageName + "\"");

  return path.join(packagePath,
    plugin.path.replace(/\/program.json$/, ''));
}

const instances = [];
Hot = function(plugin, forceEnabled) {
  this.id = Random.id(3);
  this.plugin = plugin;

  this.sentFiles = {};
  this.pluginInits = [];
  this.cacheDir = null;

  instances.push(this);

  this.forceEnabled = forceEnabled;
  this.setEnabledStatus();
  if (!this.enabled) {
    // TODO, for live status change, we need to see if we've initted before
    // and send the data if the status changes.  possibly move code to setStatus.
    return;
  }

  var pluginPath = getPluginPath(plugin);
  if (!pluginPath) {
    return log("Couldn't find plugin path for: " + plugin);
  }
  this.pluginPath = pluginPath;

  const data = {
    type: 'PLUGIN_INIT',
    id: this.id,
    name: plugin,
    path: pluginPath
  };

  this.send(data);
  this.pluginInits.push(data);
};

Hot.onReconnect = function() {
  instances.forEach(function(hot) {
    hot.pluginInits.forEach(function(init) {
      hot.send(init);
    });

    if (Object.keys(hot.sentFiles).length)
      hot.send({
        type: 'fileData',
        files: hot.sentFiles
      });

    if (hot.cacheDir)
      hot.send({ type: 'setDiskCacheDirectory', dir: hot.cacheDir });
  });
};

Hot.setEnabledStatuses = function() {
  instances.forEach(function(hot) {
    hot.setEnabledStatus();
  });
};

Hot.prototype.setEnabledStatus = function() {
  var oldState = this.enabled;

  if (this.forceEnabled || enabled === true || enabled === undefined)
    this.enabled = true;
  else if (_.isArray(enabled))
    this.enabled = _.contains(enabled, this.plugin.replace(/\/.+$/, ''));
  else
    this.enabled = false;

  if (oldState !== this.enabled) {
    debug('Plugin "' + this.plugin + '" enabled: ' + this.enabled);
  }
};

Hot.prototype.wrap = function(compiler) {
  var self = this;

  var origProcessFilesForTarget = compiler.processFilesForTarget;
  compiler.processFilesForTarget = function(inputFiles) {
    origProcessFilesForTarget.call(compiler, inputFiles);
    self.processFilesForTarget(inputFiles);
  }

  var origSetDiskCacheDirectory = compiler.setDiskCacheDirectory;
  compiler.setDiskCacheDirectory = function(cacheDir) {
    origSetDiskCacheDirectory.call(compiler, cacheDir);
    self.setDiskCacheDirectory(cacheDir);
  }

  return compiler;
}

Hot.prototype.send = function(payload) {
  if (!this.pluginPath)
    return;

  payload.pluginId = this.id;
  Hot.send(payload);
};

Hot.prototype.setDiskCacheDirectory = function(cacheDir) {
  this.cacheDir = cacheDir;
  this.send({ type: 'setDiskCacheDirectory', dir: cacheDir });
};

// Reduce size of data sent to the accelerator for performance
function reduceResolverCache(cache) {
  if (!cache)
    return cache;

  var key, out = {};
  for (key in cache)
    out[key] = cache[key].id

  return out;
}

// TODO babelrc cache too

Hot.prototype.processFilesForTarget = function(inputFiles) {
  var data = {};
  var self = this;
  var currentFiles = [];

  inputFiles.forEach(function(inputFile) {
    var file;
    var sourceBatch;
    if (inputFile.getArch() === "web.browser") {
      file = convertToOSPath(
        inputFile._resourceSlot.packageSourceBatch.sourceRoot +
        '/' + // convertToOSPath is expecting a / of course...
        inputFile.getPathInPackage()
      );
      currentFiles.push(file);

      if (!self.sentFiles[file]) {
        sourceBatch = inputFile._resourceSlot.packageSourceBatch;
        data[file] = {
          packageName: inputFile.getPackageName(),
          pathInPackage: inputFile.getPathInPackage(),
          displayPath: inputFile.getDisplayPath(),
          extension: inputFile.getExtension(),
          basename: inputFile.getBasename(),
          fileOptions: inputFile.getFileOptions(),
          //sourceRoot: inputFile._resourceSlot.packageSourceBatch.sourceRoot,
          // only send what we need, avoid circular refs, etc.
          _resourceSlot: {
            packageSourceBatch: {
              sourceRoot: sourceBatch.sourceRoot
            }
          },
//          resolverMap: reduceResolverCache(sourceBatch._resolver && sourceBatch._resolver._resolveCache),
          _controlFileCache: inputFile._controlFileCache,
          _reducedResolveCache: inputFile._resolveCache
        };
        if (sourceBatch.unibuild) {
          data[file]._resourceSlot.packageSourceBatch.unibuild = {
            nodeModulesDirectories: sourceBatch.unibuild.nodeModulesDirectories
          };
        }

        // console.log(data[file]);
        self.sentFiles[file] = data[file];
      }
    }
  });

  // Remove files that are no longer being processed (e.g. deleted files)
  Object.keys(self.sentFiles).forEach(function(file) {
    if (!currentFiles[file])
      delete self.sentFiles[file];
  });

  if (Object.keys(data).length)
    this.send({
      type: 'fileData',
      files: data
    });
};

// These next two from meteor/tools/static-assets/server/mini-files.js
var convertToOSPath = function (standardPath, partialPath) {
  if (process.platform === "win32") {
    return toDosPath(standardPath, partialPath);
  }

  return standardPath;
};
var toDosPath = function (p, partialPath) {
  if (p[0] === '/' && ! partialPath) {
    if (! /^\/[A-Za-z](\/|$)/.test(p))
      throw new Error("Surprising path: " + p);
    // transform a previously windows path back
    // "/C/something" to "c:/something"
    p = p[1] + ":" + p.slice(2);
  }

  p = p.replace(/\//g, '\\');
  return p;
};
