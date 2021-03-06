goog.provide('olcs.AbstractSynchronizer');

goog.require('goog.asserts');

goog.require('ol');
goog.require('ol.Observable');
goog.require('ol.events');
goog.require('ol.layer.Group');



/**
 * @param {!ol.Map} map
 * @param {!Cesium.Scene} scene
 * @constructor
 * @template T
 * @struct
 * @abstract
 * @api
 */
olcs.AbstractSynchronizer = function(map, scene) {
  /**
   * @type {!ol.Map}
   * @protected
   */
  this.map = map;

  /**
   * @type {ol.View}
   * @protected
   */
  this.view = map.getView();

  /**
   * @type {!Cesium.Scene}
   * @protected
   */
  this.scene = scene;

  /**
   * @type {ol.Collection.<ol.layer.Base>}
   * @protected
   */
  this.olLayers = map.getLayerGroup().getLayers();

  /**
   * @type {ol.layer.Group}
   */
  this.mapLayerGroup = map.getLayerGroup();

  /**
   * Map of OpenLayers layer ids (from ol.getUid) to the Cesium ImageryLayers.
   * Null value means, that we are unable to create equivalent layers.
   * @type {Object.<string, ?Array.<T>>}
   * @protected
   */
  this.layerMap = {};

  /**
   * Map of listen keys for OpenLayers layer layers ids (from ol.getUid).
   * @type {!Object.<string, Array<ol.EventsKey>>}
   * @protected
   */
  this.olLayerListenKeys = {};

  /**
   * Map of listen keys for OpenLayers layer groups ids (from ol.getUid).
   * @type {!Object.<string, !Array.<ol.EventsKey>>}
   * @private
   */
  this.olGroupListenKeys_ = {};
};


/**
 * Destroy all and perform complete synchronization of the layers.
 * @api
 */
olcs.AbstractSynchronizer.prototype.synchronize = function() {
  this.destroyAll();
  this.addLayers_(this.mapLayerGroup);
};


/**
 * Order counterparts using the same algorithm as the Openlayers renderer:
 * z-index then original sequence order.
 * @protected
 */
olcs.AbstractSynchronizer.prototype.orderLayers = function() {
  // Ordering logics is handled in subclasses.
};


/**
 * Add a layer hierarchy.
 * @param {ol.layer.Base} root
 * @private
 */
olcs.AbstractSynchronizer.prototype.addLayers_ = function(root) {
  /** @type {Array<olcsx.LayerWithParents>} */
  const fifo = [{
    layer: root,
    parents: []
  }];
  while (fifo.length > 0) {
    const olLayerWithParents = fifo.splice(0, 1)[0];
    const olLayer = olLayerWithParents.layer;
    const olLayerId = ol.getUid(olLayer).toString();
    this.olLayerListenKeys[olLayerId] = [];
    goog.asserts.assert(!this.layerMap[olLayerId]);

    let cesiumObjects = null;
    if (olLayer instanceof ol.layer.Group) {
      this.listenForGroupChanges_(olLayer);
      if (olLayer !== this.mapLayerGroup) {
        cesiumObjects = this.createSingleLayerCounterparts(olLayerWithParents);
      }
      if (!cesiumObjects) {
        olLayer.getLayers().forEach((l) => {
          if (l) {
            const newOlLayerWithParents = {
              layer: l,
              parents: olLayer === this.mapLayerGroup ?
                [] :
                [olLayerWithParents.layer].concat(olLayerWithParents.parents)
            };
            fifo.push(newOlLayerWithParents);
          }
        });
      }
    } else {
      cesiumObjects = this.createSingleLayerCounterparts(olLayerWithParents);
      if (!cesiumObjects) {
        // keep an eye on the layers that once failed to be added (might work when the layer is updated)
        // for example when a source is set after the layer is added to the map
        const layerId = olLayerId;
        const layerWithParents = olLayerWithParents;
        const onLayerChange = (e) => {
          const cesiumObjs = this.createSingleLayerCounterparts(layerWithParents);
          if (cesiumObjs) {
            // unsubscribe event listener
            layerWithParents.layer.un('change', onLayerChange, this);
            this.addCesiumObjects_(cesiumObjs, layerId, layerWithParents.layer);
            this.orderLayers();
          }
        };
        this.olLayerListenKeys[olLayerId].push(ol.events.listen(layerWithParents.layer, 'change', onLayerChange, this));
      }
    }
    // add Cesium layers
    if (cesiumObjects) {
      this.addCesiumObjects_(cesiumObjects, olLayerId, olLayer);
    }
  }

  this.orderLayers();
};

/**
 * Add Cesium objects.
 * @param {Array.<T>} cesiumObjects
 * @param {string} layerId
 * @param {ol.layer.Base} layer
 * @private
 */
olcs.AbstractSynchronizer.prototype.addCesiumObjects_ = function(cesiumObjects, layerId, layer) {
  this.layerMap[layerId] = cesiumObjects;
  this.olLayerListenKeys[layerId].push(ol.events.listen(layer, 'change:zIndex', this.orderLayers, this));
  cesiumObjects.forEach((cesiumObject) => {
    this.addCesiumObject(cesiumObject);
  });
};


/**
 * Remove and destroy a single layer.
 * @param {ol.layer.Layer} layer
 * @return {boolean} counterpart destroyed
 * @private
 */
olcs.AbstractSynchronizer.prototype.removeAndDestroySingleLayer_ = function(layer) {
  const uid = ol.getUid(layer).toString();
  const counterparts = this.layerMap[uid];
  if (!!counterparts) {
    counterparts.forEach((counterpart) => {
      this.removeSingleCesiumObject(counterpart, false);
      this.destroyCesiumObject(counterpart);
    });
    this.olLayerListenKeys[uid].forEach(ol.Observable.unByKey);
    delete this.olLayerListenKeys[uid];
  }
  delete this.layerMap[uid];
  return !!counterparts;
};


/**
 * Unlisten a single layer group.
 * @param {ol.layer.Group} group
 * @private
 */
olcs.AbstractSynchronizer.prototype.unlistenSingleGroup_ = function(group) {
  if (group === this.mapLayerGroup) {
    return;
  }
  const uid = ol.getUid(group).toString();
  const keys = this.olGroupListenKeys_[uid];
  keys.forEach((key) => {
    ol.Observable.unByKey(key);
  });
  delete this.olGroupListenKeys_[uid];
  delete this.layerMap[uid];
};


/**
 * Remove layer hierarchy.
 * @param {ol.layer.Base} root
 * @private
 */
olcs.AbstractSynchronizer.prototype.removeLayer_ = function(root) {
  if (!!root) {
    const fifo = [root];
    while (fifo.length > 0) {
      const olLayer = fifo.splice(0, 1)[0];
      const done = this.removeAndDestroySingleLayer_(olLayer);
      if (olLayer instanceof ol.layer.Group) {
        this.unlistenSingleGroup_(olLayer);
        if (!done) {
          // No counterpart for the group itself so removing
          // each of the child layers.
          olLayer.getLayers().forEach((l) => {
            fifo.push(l);
          });
        }
      }
    }
  }
};


/**
 * Register listeners for single layer group change.
 * @param {ol.layer.Group} group
 * @private
 */
olcs.AbstractSynchronizer.prototype.listenForGroupChanges_ = function(group) {
  const uuid = ol.getUid(group).toString();

  goog.asserts.assert(this.olGroupListenKeys_[uuid] === undefined);

  const listenKeyArray = [];
  this.olGroupListenKeys_[uuid] = listenKeyArray;

  // only the keys that need to be relistened when collection changes
  let contentKeys = [];
  const listenAddRemove = (function() {
    const collection = group.getLayers();
    if (collection) {
      contentKeys = [
        collection.on('add', function(event) {
          this.addLayers_(event.element);
        }, this),
        collection.on('remove', function(event) {
          this.removeLayer_(event.element);
        }, this)
      ];
      listenKeyArray.push(...contentKeys);
    }
  }).bind(this);

  listenAddRemove();

  listenKeyArray.push(group.on('change:layers', (e) => {
    contentKeys.forEach((el) => {
      const i = listenKeyArray.indexOf(el);
      if (i >= 0) {
        listenKeyArray.splice(i, 1);
      }
      ol.Observable.unByKey(el);
    });
    listenAddRemove();
  }));
};


/**
 * Destroys all the created Cesium objects.
 * @protected
 */
olcs.AbstractSynchronizer.prototype.destroyAll = function() {
  this.removeAllCesiumObjects(true); // destroy
  let objKey;
  for (objKey in this.olGroupListenKeys_) {
    const keys = this.olGroupListenKeys_[objKey];
    keys.forEach(ol.Observable.unByKey);
  }
  for (objKey in this.olLayerListenKeys) {
    this.olLayerListenKeys[objKey].forEach(ol.Observable.unByKey);
  }
  this.olGroupListenKeys_ = {};
  this.olLayerListenKeys = {};
  this.layerMap = {};
};


/**
 * Adds a single Cesium object to the collection.
 * @param {!T} object
 * @abstract
 * @protected
 */
olcs.AbstractSynchronizer.prototype.addCesiumObject = function(object) {};


/**
 * @param {!T} object
 * @abstract
 * @protected
 */
olcs.AbstractSynchronizer.prototype.destroyCesiumObject = function(object) {};


/**
 * Remove single Cesium object from the collection.
 * @param {!T} object
 * @param {boolean} destroy
 * @abstract
 * @protected
 */
olcs.AbstractSynchronizer.prototype.removeSingleCesiumObject = function(object, destroy) {};


/**
 * Remove all Cesium objects from the collection.
 * @param {boolean} destroy
 * @abstract
 * @protected
 */
olcs.AbstractSynchronizer.prototype.removeAllCesiumObjects = function(destroy) {};


/**
 * @param {olcsx.LayerWithParents} olLayerWithParents
 * @return {?Array.<T>}
 * @abstract
 * @protected
 */
olcs.AbstractSynchronizer.prototype.createSingleLayerCounterparts = function(olLayerWithParents) {};
