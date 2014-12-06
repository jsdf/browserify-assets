var fs = require('fs');
var path = require('path');
var util = require('util');
var assert = require('assert');

var through = require('through2');
var async = require('async');
var concatStream = require('concat-stream');
var xtend = require('xtend');
var glob = require('glob');
var combineStreams = require('stream-combiner');
var browserifyCache = require('browserify-cache-api');
var mothership = require('mothership');

module.exports = browserifyAssets;

function browserifyAssets(files, opts) {
  // browserify plugin boilerplate
  // normalises variable arguments
  var b;
  if (!opts) {
    opts = files || {};
    files = undefined;
    b = typeof opts.bundle === 'function' ? opts : require('browserify')(xtend(browserifyCache.args, opts));
  } else {
    b = typeof files.bundle === 'function' ? files : require('browserify')(files, xtend(browserifyCache.args, opts));
  }

  browserifyCache(b, opts);

  // override browserify bundle() method
  var bundle = b.bundle.bind(b);
  b.bundle = function (cb) {
    // more browserify plugin boilerplate
    if (b._pending) return bundle(cb);

    // asset build progress
    var packagesBuildingAssets = {};
    var filesDiscoveringPackages = {};
    var bundleComplete = false;

    // provide asset bundle stream to api consumers
    var assetStream = through();
    b.emit('assetStream', assetStream, 'style');

    // init metrics
    var time = null;
    var bytes = 0;
    b.pipeline.get('record').on('end', function () {
      time = Date.now();
    });
    
    // intercept deps in pipeline and add to asset build
    b.pipeline.get('deps').push(through.obj(function(dep, enc, next) {
      var filepath = dep && dep.file || dep.id;
      if (filepath != null) buildAssetsForFile(filepath)
      this.push(dep);
      next();
    }, function() {
      this.push(null);
    }));
    
    // produce metrics events
    b.pipeline.get('wrap').push(through(function(buf, enc, next) {
      bytes += buf.length;
      this.push(buf);
      next();
    }, function() {
      var delta = Date.now() - time;
      b.emit('time', delta);
      b.emit('bytes', bytes);
      b.emit('log', bytes + ' bytes written ('
          + (delta / 1000).toFixed(2) + ' seconds)'
      );

      // no more packages to be required
      bundleComplete = true;
      cleanupWhenAssetBundleComplete();

      this.push(null);
    }));

    function cleanupWhenAssetBundleComplete() {
      if (
        bundleComplete
        && allItemsComplete(filesDiscoveringPackages)
        && allItemsComplete(packagesBuildingAssets)
      ) {
        assetStream.end();

        b.emit('allBundlesComplete')
      }
    }

    function assetComplete(err, pkgpath) {
      if (err) assetStream.emit('error', err, pkgpath);
      packagesBuildingAssets[pkgpath] = 'COMPLETE';

      cleanupWhenAssetBundleComplete();
    }

    function buildAssetsForFile(file) {
      assertExists(file, 'file');
      var co = browserifyCache.getCacheObjects(b);
      var pkgpath = co.filesPackagePaths[file];
      if (pkgpath) {
        buildAssetsForPackage(pkgpath);
      } else {
        filesDiscoveringPackages[file] = 'STARTED';
        mothership(file, function(pkg) { return true }, function (err, res) {
          if (err) return b.emit('error', err);
          filesDiscoveringPackages[file] = 'COMPLETE';
          buildAssetsForPackage(res.path, res.pack);
        });
      }
      // else console.warn('waiting for',file)
    }

    function buildAssetsForPackage(pkgpath, pkgLoaded) {
      assertExists(pkgpath, 'pkgpath');
      var co = browserifyCache.getCacheObjects(b);
      var status = packagesBuildingAssets[pkgpath];
      if (status && status !== 'PENDING') return;

      packagesBuildingAssets[pkgpath] = 'STARTED';

      var pkg = pkgLoaded || co.packages[pkgpath];

      pkg.__dirname = pkg.__dirname || path.dirname(pkgpath);

      buildPackageAssetsAndWriteToStream(pkg, assetStream, function(err) {
        assetComplete(err, pkgpath);
      });
    }

    return bundle(cb);
  };

  return b;
}

// asset building

function buildPackageAssetsAndWriteToStream(pkg, assetStream, packageDone) {
  assertExists(pkg, 'pkg'), assertExists(assetStream, 'assetStream'), assertExists(packageDone, 'packageDone');

  if (!pkg.__dirname) return packageDone();

  try {
    var transformStreamForFile = streamFactoryForPackage(pkg);
  } catch (err) {
    return packageDone(err);
  }

  var assetGlobs = [].concat(pkg.style || []);
  async.each(assetGlobs, function(assetGlob, assetGlobDone) {
    glob(path.join(pkg.__dirname, assetGlob), function(err, assetFilePaths) {
      if (err) return assetGlobDone(err);

      async.each((assetFilePaths || []), function(assetFilePath, assetDone) {
        fs.createReadStream(assetFilePath, {encoding: 'utf8'})
          .on('error', assetDone)
          .pipe(transformStreamForFile(assetFilePath))
          .on('error', assetDone)
          .pipe(streamAccumlator(assetStream, assetDone));
      }, assetGlobDone);
    });
  }, packageDone);
}

function streamAccumlator(outputStream, done) {
  return concatStream(function (accumulated) {
    outputStream.write(accumulated+'\n');
    done();
  });
}

function streamFactoryForPackage(pkg) {
  assertExists(pkg, 'pkg');
  var transforms = (pkg.transforms || []).map(function(tr){
    return findTransform(tr, pkg);
  });

  return function(file) {
    assertExists(file, 'file');
    return combineStreams(transforms.map(function(transform) {
      return transform(file)
    }));
  };
}

function findTransform(transform, pkg) {
  if (typeof transform === 'function') return transform;

  try {
    return require(transform)
  } catch (err) {
    try {
      var rebasedPath
      if (isLocalPath(transform)) rebasedPath = path.resolve(pkg.__dirname, transform)
      else rebasedPath = path.join(pkg.__dirname, 'node_modules', transform)
      return require(rebasedPath)
    } catch (err) {
      throw new Error("couldn't resolve transform "+transform+" while processing package "+pkg.__dirname)
    }
  }
}

function allItemsComplete(itemStatuses) {
  var numPending = values(itemStatuses).filter(function(status) {
    return status !== 'COMPLETE'
  }).length;
  return numPending === 0;
}

// util

function values(obj) {
  return Object.keys(obj).map(function(key) { return obj[key]; });
}

function assertExists(value, name) {
  assert(value, 'missing '+name);
}

function isLocalPath(filepath) {
  var charAt0 = filepath.charAt(0)
  return charAt0 === '.' || charAt0 === '/'
}
