/*global define*/
define([
    '../Core/BoundingSphere',
    '../Core/Cartesian3',
    '../Core/Cartographic',
    '../Core/Color',
    '../Core/ComponentDatatype',
    '../Core/defaultValue',
    '../Core/defined',
    '../Core/destroyObject',
    '../Core/defineProperties',
    '../Core/DeveloperError',
    '../Core/Ellipsoid',
    '../Core/getMagic',
    '../Core/getStringFromTypedArray',
    '../Core/loadArrayBuffer',
    '../Core/Matrix4',
    '../Core/Request',
    '../Core/RequestScheduler',
    '../Core/RequestType',
    '../Core/TranslationRotationScale',
    '../ThirdParty/when',
    './Cesium3DTileBatchTable',
    './Cesium3DTileContentState',
    './Cesium3DTileFeature',
    './BillboardCollection',
    './GroundPolylineBatch',
    './GroundPrimitiveBatch',
    './LabelCollection',
    './VerticalOrigin'
], function(
    BoundingSphere,
    Cartesian3,
    Cartographic,
    Color,
    ComponentDatatype,
    defaultValue,
    defined,
    destroyObject,
    defineProperties,
    DeveloperError,
    Ellipsoid,
    getMagic,
    getStringFromTypedArray,
    loadArrayBuffer,
    Matrix4,
    Request,
    RequestScheduler,
    RequestType,
    TranslationRotationScale,
    when,
    Cesium3DTileBatchTable,
    Cesium3DTileContentState,
    Cesium3DTileFeature,
    BillboardCollection,
    GroundPolylineBatch,
    GroundPrimitiveBatch,
    LabelCollection,
    VerticalOrigin) {
    'use strict';

    /**
     * @alias Vector3DTileContent
     * @constructor
     *
     * @private
     */
    function Vector3DTileContent(tileset, tile, url) {
        this._url = url;
        this._tileset = tileset;
        this._tile = tile;

        this._polygons = undefined;
        this._polylines = undefined;
        this._outlines = undefined;

        this._billboardCollection = undefined;
        this._labelCollection = undefined;

        /**
         * The following properties are part of the {@link Cesium3DTileContent} interface.
         */
        this.state = Cesium3DTileContentState.UNLOADED;
        this.batchTable = undefined;
        this.featurePropertiesDirty = false;
        this.boundingSphere = tile.contentBoundingVolume.boundingSphere;

        this._contentReadyToProcessPromise = when.defer();
        this._readyPromise = when.defer();
    }

    defineProperties(Vector3DTileContent.prototype, {
        /**
         * Part of the {@link Cesium3DTileContent} interface.
         */
        featuresLength : {
            get : function() {
                return defined(this.batchTable) ? this.batchTable.featuresLength : 0;
            }
        },

        /**
         * Part of the {@link Cesium3DTileContent} interface.
         */
        innerContents : {
            get : function() {
                return undefined;
            }
        },

        /**
         * Part of the {@link Cesium3DTileContent} interface.
         */
        contentReadyToProcessPromise : {
            get : function() {
                return this._contentReadyToProcessPromise.promise;
            }
        },

        /**
         * Part of the {@link Cesium3DTileContent} interface.
         */
        readyPromise : {
            get : function() {
                return this._readyPromise.promise;
            }
        }
    });

    function createFeatures(content) {
        var tileset = content._tileset;
        var featuresLength = content.featuresLength;
        if (!defined(content._features) && (featuresLength > 0)) {
            var features = new Array(featuresLength);
            for (var i = 0; i < featuresLength; ++i) {
                features[i] = new Cesium3DTileFeature(tileset, content, i);
            }
            content._features = features;
        }
    }

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Vector3DTileContent.prototype.hasProperty = function(name) {
        return this.batchTable.hasProperty(name);
    };

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Vector3DTileContent.prototype.getFeature = function(batchId) {
        //>>includeStart('debug', pragmas.debug);
        var featuresLength = this.featuresLength;
        if (!defined(batchId) || (batchId < 0) || (batchId >= featuresLength)) {
            throw new DeveloperError('batchId is required and between zero and featuresLength - 1 (' + (featuresLength - 1) + ').');
        }
        //>>includeEnd('debug');

        createFeatures(this);
        return this._features[batchId];
    };

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Vector3DTileContent.prototype.request = function() {
        var that = this;

        var distance = this._tile.distanceToCamera;
        var promise = RequestScheduler.schedule(new Request({
            url : this._url,
            server : this._tile.requestServer,
            requestFunction : loadArrayBuffer,
            type : RequestType.TILES3D,
            distance : distance
        }));

        if (!defined(promise)) {
            return false;
        }

        this.state = Cesium3DTileContentState.LOADING;
        promise.then(function(arrayBuffer) {
            if (that.isDestroyed()) {
                return when.reject('tileset is destroyed');
            }
            that.initialize(arrayBuffer);
        }).otherwise(function(error) {
            that.state = Cesium3DTileContentState.FAILED;
            that._readyPromise.reject(error);
        });
        return true;
    };

    function createColorChangedCallback(content, numberOfPolygons) {
        return function(batchId, color) {
            if (defined(content._polygons) && batchId < numberOfPolygons) {
                content._polygons.updateCommands(batchId, color);
            }
        };
    }

    var sizeOfUint16 = Uint16Array.BYTES_PER_ELEMENT;
    var sizeOfUint32 = Uint32Array.BYTES_PER_ELEMENT;
    var sizeOfFloat32 = Float32Array.BYTES_PER_ELEMENT;

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Vector3DTileContent.prototype.initialize = function(arrayBuffer, byteOffset) {
        byteOffset = defaultValue(byteOffset, 0);

        var uint8Array = new Uint8Array(arrayBuffer);
        var magic = getMagic(uint8Array, byteOffset);
        if (magic !== 'vctr') {
            throw new DeveloperError('Invalid Vector tile.  Expected magic=vctr.  Read magic=' + magic);
        }

        var view = new DataView(arrayBuffer);
        byteOffset += sizeOfUint32;  // Skip magic number

        //>>includeStart('debug', pragmas.debug);
        var version = view.getUint32(byteOffset, true);
        if (version !== 1) {
            throw new DeveloperError('Only Vector tile version 1 is supported.  Version ' + version + ' is not.');
        }
        //>>includeEnd('debug');
        byteOffset += sizeOfUint32;

        var byteLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;

        if (byteLength === 0) {
            this.state = Cesium3DTileContentState.PROCESSING;
            this._contentReadyToProcessPromise.resolve(this);
            this.state = Cesium3DTileContentState.READY;
            this._readyPromise.resolve(this);
            return;
        }

        var featureTableJSONByteLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;

        //>>includeStart('debug', pragmas.debug);
        if (featureTableJSONByteLength === 0) {
            throw new DeveloperError('Feature table must have a byte length greater than zero');
        }
        //>>includeEnd('debug');

        var featureTableBinaryByteLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;
        var batchTableJSONByteLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;
        var batchTableBinaryByteLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;
        var indicesByteLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;
        var positionByteLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;
        var polylinePositionByteLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;
        var pointsPositionByteLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;

        var featureTableString = getStringFromTypedArray(uint8Array, byteOffset, featureTableJSONByteLength);
        var featureTableJson = JSON.parse(featureTableString);
        byteOffset += featureTableJSONByteLength;

        var featureTableBinary = new Uint8Array(arrayBuffer, byteOffset, featureTableBinaryByteLength);
        byteOffset += featureTableBinaryByteLength;

        var batchTableJson;
        var batchTableBinary;
        if (batchTableJSONByteLength > 0) {
            // PERFORMANCE_IDEA: is it possible to allocate this on-demand?  Perhaps keep the
            // arraybuffer/string compressed in memory and then decompress it when it is first accessed.
            //
            // We could also make another request for it, but that would make the property set/get
            // API async, and would double the number of numbers in some cases.
            var batchTableString = getStringFromTypedArray(uint8Array, byteOffset, batchTableJSONByteLength);
            batchTableJson = JSON.parse(batchTableString);
            byteOffset += batchTableJSONByteLength;

            if (batchTableBinaryByteLength > 0) {
                // Has a batch table binary
                batchTableBinary = new Uint8Array(arrayBuffer, byteOffset, batchTableBinaryByteLength);
                // Copy the batchTableBinary section and let the underlying ArrayBuffer be freed
                batchTableBinary = new Uint8Array(batchTableBinary);
                byteOffset += batchTableBinaryByteLength;
            }
        }

        var numberOfPolygons = featureTableJson.POLYGONS_LENGTH;
        //>>includeStart('debug', pragmas.debug);
        if (!defined(numberOfPolygons)) {
            throw new DeveloperError('Global property: POLYGONS_LENGTH must be defined.');
        }
        //>>includeEnd('debug');

        var numberOfPolylines = featureTableJson.POLYLINES_LENGTH;
        //>>includeStart('debug', pragmas.debug);
        if (!defined(numberOfPolylines)) {
            throw new DeveloperError('Global property: POLYLINES_LENGTH must be defined.');
        }
        //>>includeEnd('debug');

        var numberOfPoints = featureTableJson.POINTS_LENGTH;
        //>>includeStart('debug', pragmas.debug);
        if (!defined(numberOfPoints)) {
            throw new DeveloperError('Global property: POINTS_LENGTH must be defined.');
        }
        //>>includeEnd('debug');

        var outlinePolygons = defaultValue(featureTableJson.OUTLINE_POLYGONS, false);
        var numberOfOutlines = outlinePolygons ? numberOfPolygons : 0;
        var totalPrimitives = numberOfPolygons + numberOfOutlines + numberOfPolylines + numberOfPoints;

        var batchTable = new Cesium3DTileBatchTable(this, totalPrimitives, batchTableJson, batchTableBinary, createColorChangedCallback(this, numberOfPolygons));
        this.batchTable = batchTable;

        var center = Cartesian3.unpack(featureTableJson.RTC_CENTER);
        var minHeight = featureTableJson.MINIMUM_HEIGHT;
        var maxHeight = featureTableJson.MAXIMUM_HEIGHT;

        var isQuantized = defined(featureTableJson.QUANTIZED_VOLUME_OFFSET) && defined(featureTableJson.QUANTIZED_VOLUME_SCALE);
        //>>includeStart('debug', pragmas.debug);
        if (!isQuantized && defined(featureTableJson.QUANTIZED_VOLUME_OFFSET)) {
            throw new DeveloperError('Global property: QUANTIZED_VOLUME_OFFSET must be defined for quantized positions.');
        }
        if (!isQuantized && defined(featureTableJson.QUANTIZED_VOLUME_SCALE)) {
            throw new DeveloperError('Global property: QUANTIZED_VOLUME_SCALE must be defined for quantized positions.');
        }
        //>>includeEnd('debug');

        var quantizedOffset;
        var quantizedScale;
        if (isQuantized) {
            quantizedOffset = Cartesian3.unpack(featureTableJson.QUANTIZED_VOLUME_OFFSET);
            quantizedScale = Cartesian3.unpack(featureTableJson.QUANTIZED_VOLUME_SCALE);
        }

        var indices = new Uint32Array(arrayBuffer, byteOffset, indicesByteLength / sizeOfUint32);
        byteOffset += indicesByteLength;

        var positions;
        var polylinePositions;
        var pointsPositions;
        if (isQuantized) {
            positions = new Uint16Array(arrayBuffer, byteOffset, positionByteLength / sizeOfUint16);
            byteOffset += positionByteLength;
            polylinePositions = new Uint16Array(arrayBuffer, byteOffset, polylinePositionByteLength / sizeOfUint16);
            byteOffset += polylinePositionByteLength;
            pointsPositions = new Uint16Array(arrayBuffer, byteOffset, pointsPositionByteLength / sizeOfUint16);
        } else {
            positions = new Float32Array(arrayBuffer, byteOffset, positionByteLength / sizeOfFloat32);
            byteOffset += positionByteLength;
            polylinePositions = new Float32Array(arrayBuffer, byteOffset, polylinePositionByteLength / sizeOfFloat32);
            byteOffset += polylinePositionByteLength;
            pointsPositions = new Float32Array(arrayBuffer, byteOffset, pointsPositionByteLength / sizeOfFloat32);
        }

        byteOffset = featureTableBinary.byteOffset + featureTableJson.POLYGON_COUNT.byteOffset;
        var counts = new Uint32Array(featureTableBinary.buffer, byteOffset, numberOfPolygons);

        byteOffset = featureTableBinary.byteOffset + featureTableJson.POLYGON_INDEX_COUNT.byteOffset;
        var indexCounts = new Uint32Array(featureTableBinary.buffer, byteOffset, numberOfPolygons);

        byteOffset = featureTableBinary.byteOffset + featureTableJson.POLYLINE_COUNT.byteOffset;
        var polylineCounts = new Uint32Array(featureTableBinary.buffer, byteOffset, numberOfPolylines);

        var n;
        var color = Color.WHITE.withAlpha(0.5);
        var batchIds = new Array(numberOfPolygons);
        for (n = 0; n < numberOfPolygons; ++n) {
            batchTable.setColor(n, color);
            batchIds[n] = n;
        }

        if (positions.length > 0) {
            this._polygons = new GroundPrimitiveBatch({
                positions : positions,
                counts : counts,
                indexCounts : indexCounts,
                indices : indices,
                minimumHeight : minHeight,
                maximumHeight : maxHeight,
                center : center,
                quantizedOffset : quantizedOffset,
                quantizedScale : quantizedScale,
                boundingVolume : this._tile._boundingVolume.boundingVolume,
                batchTable : this.batchTable,
                batchIds : batchIds
            });
        }

        if (outlinePolygons && numberOfPolygons > 0) {
            var outlinePositionsLength = positions.length + 3 * numberOfPolygons;
            var outlinePositions = isQuantized ? new Uint16Array(outlinePositionsLength) : new Float32Array(outlinePositionsLength);
            var outlineCounts = new Array(numberOfPolygons);
            var outlineWidths = new Array(numberOfPolygons);
            batchIds = new Array(numberOfPolygons);
            var outlinePositionIndex = 0;
            var polygonOffset = 0;
            for (var s = 0; s < numberOfPolygons; ++s) {
                var count = counts[s];
                for (var t = 0; t < count; ++t) {
                    var index = polygonOffset + 3 * t;
                    outlinePositions[outlinePositionIndex++] = positions[index];
                    outlinePositions[outlinePositionIndex++] = positions[index + 1];
                    outlinePositions[outlinePositionIndex++] = positions[index + 2];
                }

                outlinePositions[outlinePositionIndex++] = positions[polygonOffset];
                outlinePositions[outlinePositionIndex++] = positions[polygonOffset + 1];
                outlinePositions[outlinePositionIndex++] = positions[polygonOffset + 2];

                polygonOffset += 3 * count;

                var outlineID = s + numberOfPolygons;
                batchTable.setColor(outlineID, Color.BLACK.withAlpha(0.7));
                outlineWidths[s] = 2.0;
                batchIds[s] = outlineID;
                outlineCounts[s] = count + 1;
            }

            this._outlines = new GroundPolylineBatch({
                positions : outlinePositions,
                widths : outlineWidths,
                counts : outlineCounts,
                batchIds : batchIds,
                center : center,
                quantizedOffset : quantizedOffset,
                quantizedScale : quantizedScale,
                boundingVolume : this._tile._boundingVolume.boundingVolume,
                batchTable : this.batchTable
            });
        }

        var widths = new Array(numberOfPolylines);
        batchIds = new Array(numberOfPolylines);
        var polygonBatchOffset = outlinePolygons && numberOfPolygons > 0 ? 2.0 * numberOfPolygons : numberOfPolygons;
        for (n = 0; n < numberOfPolylines; ++n) {
            var id = n + polygonBatchOffset;
            batchTable.setColor(id, color);
            widths[n] = 2.0;
            batchIds[n] = id;
        }

        if (polylinePositions.length > 0) {
            this._polylines = new GroundPolylineBatch({
                positions : polylinePositions,
                widths : widths,
                counts : polylineCounts,
                batchIds : batchIds,
                center : center,
                quantizedOffset : quantizedOffset,
                quantizedScale : quantizedScale,
                boundingVolume : this._tile._boundingVolume.boundingVolume,
                batchTable : this.batchTable
            });
        }

        if (pointsPositions.length > 0) {
            var decodeMatrix;
            if (defined(quantizedOffset) && defined(quantizedScale)) {
                decodeMatrix = Matrix4.fromTranslationRotationScale(new TranslationRotationScale(quantizedOffset, undefined, quantizedScale), new Matrix4());
            } else {
                decodeMatrix = Matrix4.IDENTITY;
            }

            color = Color.WHITE;
            var outlineColor = Color.BLACK;
            var pixelSize = 8.0;
            var outlineWidth = 2.0;

            this._billboardCollection = new BillboardCollection();
            this._labelCollection = new LabelCollection();

            for (n = 0; n < numberOfPoints; ++n) {
                var x = pointsPositions[n * 3];
                var y = pointsPositions[n * 3 + 1];
                var z = pointsPositions[n * 3 + 2];
                var position = Cartesian3.fromElements(x, y, z);
                Matrix4.multiplyByPoint(decodeMatrix, position, position);
                Cartesian3.add(position, center, position);

                var batchIndex = n + numberOfPolygons + numberOfPolylines + (outlinePolygons && numberOfPolygons > 0 ? numberOfPolygons : 0);
                var b = this._billboardCollection.add();
                b.position = position;
                b.verticalOrigin = VerticalOrigin.BOTTOM;
                b._batchIndex = batchIndex;

                var centerAlpha = color.alpha;
                var cssColor = color.toCssColorString();
                var cssOutlineColor = outlineColor.toCssColorString();
                var textureId = JSON.stringify([cssColor, pixelSize, cssOutlineColor, outlineWidth]);

                b.setImage(textureId, createCallback(centerAlpha, cssColor, cssOutlineColor, outlineWidth, pixelSize));

                var l = this._labelCollection.add();
                l.show = false;
                l.text = '';
                l.position = position;
                l.verticalOrigin = VerticalOrigin.BOTTOM;
                l._batchIndex = batchIndex;
            }
        }

        this.state = Cesium3DTileContentState.PROCESSING;
        this._contentReadyToProcessPromise.resolve(this);
    };

    function createCallback(centerAlpha, cssColor, cssOutlineColor, cssOutlineWidth, newPixelSize) {
        return function(id) {
            var canvas = document.createElement('canvas');

            var length = newPixelSize + (2 * cssOutlineWidth);
            canvas.height = canvas.width = length;

            var context2D = canvas.getContext('2d');
            context2D.clearRect(0, 0, length, length);

            if (cssOutlineWidth !== 0) {
                context2D.beginPath();
                context2D.arc(length / 2, length / 2, length / 2, 0, 2 * Math.PI, true);
                context2D.closePath();
                context2D.fillStyle = cssOutlineColor;
                context2D.fill();
                // Punch a hole in the center if needed.
                if (centerAlpha < 1.0) {
                    context2D.save();
                    context2D.globalCompositeOperation = 'destination-out';
                    context2D.beginPath();
                    context2D.arc(length / 2, length / 2, newPixelSize / 2, 0, 2 * Math.PI, true);
                    context2D.closePath();
                    context2D.fillStyle = 'black';
                    context2D.fill();
                    context2D.restore();
                }
            }

            context2D.beginPath();
            context2D.arc(length / 2, length / 2, newPixelSize / 2, 0, 2 * Math.PI, true);
            context2D.closePath();
            context2D.fillStyle = cssColor;
            context2D.fill();

            return canvas;
        };
    }

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Vector3DTileContent.prototype.applyDebugSettings = function(enabled, color) {
        if (defined(this._polygons)) {
            this._polygons.applyDebugSettings(enabled, color);
        }

        if (defined(this._outlines)) {
            this._outlines.applyDebugSettings(enabled, color);
        }

        if (defined(this._polylines)) {
            this._polylines.applyDebugSettings(enabled, color);
        }

        //TODO: debug settings for points/billboards/labels
    };

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Vector3DTileContent.prototype.applyStyleWithShader = function(frameState, style) {
        return false;
    };

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Vector3DTileContent.prototype.update = function(tileset, frameState) {
        if (defined(this.batchTable)) {
            this.batchTable.update(tileset, frameState);
        }

        if (defined(this._polygons)) {
            this._polygons.update(frameState);
        }

        if (defined(this._outlines)) {
            this._outlines.update(frameState);
        }

        if (defined(this._polylines)) {
            this._polylines.update(frameState);
        }

        if (defined(this._billboardCollection)) {
            this._billboardCollection.update(frameState);
            this._labelCollection.update(frameState);
        }

        if (this.state !== Cesium3DTileContentState.READY) {
            this.state = Cesium3DTileContentState.READY;
            this._readyPromise.resolve(this);
        }
    };

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Vector3DTileContent.prototype.isDestroyed = function() {
        return false;
    };

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Vector3DTileContent.prototype.destroy = function() {
        this._polygons = this._polygons && this._polygons.destroy();
        this._polylines = this._polylines && this._polylines.destroy();
        this._outlines = this._outlines && this._outlines.destroy();
        this._billboardCollection = this._billboardCollection && this._billboardCollection.destroy();
        this._labelCollection = this._labelCollection && this._labelCollection.destroy();
        return destroyObject(this);
    };

    return Vector3DTileContent;
});
