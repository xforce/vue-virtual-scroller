import { ResizeObserver } from 'vue-resize';
import { ObserveVisibility } from 'vue-observe-visibility';
import ScrollParent from 'scrollparent';
import Vue from 'vue';

var config = {
  itemsLimit: 1000
};

function _extends() {
  _extends = Object.assign || function (target) {
    for (var i = 1; i < arguments.length; i++) {
      var source = arguments[i];

      for (var key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
          target[key] = source[key];
        }
      }
    }

    return target;
  };

  return _extends.apply(this, arguments);
}

const props = {
  items: {
    type: Array,
    required: true
  },
  keyField: {
    type: String,
    default: 'id'
  },
  direction: {
    type: String,
    default: 'vertical',
    validator: value => ['vertical', 'horizontal'].includes(value)
  }
};
function simpleArray() {
  return this.items.length && typeof this.items[0] !== 'object';
}

let supportsPassive = false;

if (typeof window !== 'undefined') {
  supportsPassive = false;

  try {
    var opts = Object.defineProperty({}, 'passive', {
      get() {
        supportsPassive = true;
      }

    });
    window.addEventListener('test', null, opts);
  } catch (e) {}
}

let uid = 0;
var script = {
  name: 'RecycleScroller',
  components: {
    ResizeObserver
  },
  directives: {
    ObserveVisibility
  },
  props: _extends({}, props, {
    itemSize: {
      type: Number,
      default: null
    },
    minItemSize: {
      type: [Number, String],
      default: null
    },
    sizeField: {
      type: String,
      default: 'size'
    },
    typeField: {
      type: String,
      default: 'type'
    },
    buffer: {
      type: Number,
      default: 200
    },
    pageMode: {
      type: Boolean,
      default: false
    },
    prerender: {
      type: Number,
      default: 0
    },
    emitUpdate: {
      type: Boolean,
      default: false
    }
  }),

  data() {
    return {
      pool: [],
      totalSize: 0,
      ready: false
    };
  },

  computed: {
    sizes() {
      if (this.itemSize === null) {
        const sizes = {
          '-1': {
            accumulator: 0
          }
        };
        const items = this.items;
        const field = this.sizeField;
        const minItemSize = this.minItemSize;
        let accumulator = 0;
        let current;

        for (let i = 0, l = items.length; i < l; i++) {
          current = items[i][field] || minItemSize;
          accumulator += current;
          sizes[i] = {
            accumulator,
            size: current
          };
        }

        return sizes;
      }

      return [];
    },

    simpleArray
  },
  watch: {
    items() {
      this.updateVisibleItems(true);
    },

    pageMode() {
      this.applyPageMode();
      this.updateVisibleItems(false);
    },

    sizes: {
      handler() {
        this.updateVisibleItems(false);
      },

      deep: true
    }
  },

  created() {
    this.$_startIndex = 0;
    this.$_endIndex = 0;
    this.$_views = new Map();
    this.$_unusedViews = new Map();
    this.$_scrollDirty = false;

    if (this.$isServer) {
      this.updateVisibleItems(false);
    }
  },

  mounted() {
    this.applyPageMode();
    this.$nextTick(() => {
      this.updateVisibleItems(true);
      this.ready = true;
    });
  },

  beforeDestroy() {
    this.removeListeners();
  },

  methods: {
    addView(pool, index, item, key, type) {
      const view = {
        item,
        position: 0
      };
      const nonReactive = {
        id: uid++,
        index,
        used: true,
        key,
        type
      };
      Object.defineProperty(view, 'nr', {
        configurable: false,
        value: nonReactive
      });
      pool.push(view);
      return view;
    },

    unuseView(view, fake) {
      if (fake === void 0) {
        fake = false;
      }

      const unusedViews = this.$_unusedViews;
      const type = view.nr.type;
      let unusedPool = unusedViews.get(type);

      if (!unusedPool) {
        unusedPool = [];
        unusedViews.set(type, unusedPool);
      }

      unusedPool.push(view);

      if (!fake) {
        view.nr.used = false;
        view.position = -9999;
        this.$_views.delete(view.nr.key);
      }
    },

    handleResize() {
      this.$emit('resize');
      if (this.ready) this.updateVisibleItems(false);
    },

    handleScroll(event) {
      if (!this.$_scrollDirty) {
        this.$_scrollDirty = true;
        requestAnimationFrame(() => {
          this.$_scrollDirty = false;
          const {
            continuous
          } = this.updateVisibleItems(false); // It seems sometimes chrome doesn't fire scroll event :/
          // When non continous scrolling is ending, we force a refresh

          if (!continuous) {
            clearTimeout(this.$_refreshTimout);
            this.$_refreshTimout = setTimeout(this.handleScroll, 100);
          }
        });
      }
    },

    handleVisibilityChange(isVisible, entry) {
      if (this.ready) {
        if (isVisible || entry.boundingClientRect.width !== 0 || entry.boundingClientRect.height !== 0) {
          this.$emit('visible');
          requestAnimationFrame(() => {
            this.updateVisibleItems(false);
          });
        } else {
          this.$emit('hidden');
        }
      }
    },

    updateVisibleItems(checkItem) {
      const itemSize = this.itemSize;
      const typeField = this.typeField;
      const keyField = this.simpleArray ? null : this.keyField;
      const items = this.items;
      const count = items.length;
      const sizes = this.sizes;
      const views = this.$_views;
      let unusedViews = this.$_unusedViews;
      const pool = this.pool;
      let startIndex, endIndex;
      let totalSize;

      if (!count) {
        startIndex = endIndex = totalSize = 0;
      } else if (this.$isServer) {
        startIndex = 0;
        endIndex = this.prerender;
        totalSize = null;
      } else {
        const scroll = this.getScroll();
        const buffer = this.buffer;
        scroll.start -= buffer;
        scroll.end += buffer; // Variable size mode

        if (itemSize === null) {
          let h;
          let a = 0;
          let b = count - 1;
          let i = ~~(count / 2);
          let oldI; // Searching for startIndex

          do {
            oldI = i;
            h = sizes[i].accumulator;

            if (h < scroll.start) {
              a = i;
            } else if (i < count - 1 && sizes[i + 1].accumulator > scroll.start) {
              b = i;
            }

            i = ~~((a + b) / 2);
          } while (i !== oldI);

          i < 0 && (i = 0);
          startIndex = i; // For container style

          totalSize = sizes[count - 1].accumulator; // Searching for endIndex

          for (endIndex = i; endIndex < count && sizes[endIndex].accumulator < scroll.end; endIndex++);

          if (endIndex === -1) {
            endIndex = items.length - 1;
          } else {
            endIndex++; // Bounds

            endIndex > count && (endIndex = count);
          }
        } else {
          // Fixed size mode
          startIndex = ~~(scroll.start / itemSize);
          endIndex = Math.ceil(scroll.end / itemSize); // Bounds

          startIndex < 0 && (startIndex = 0);
          endIndex > count && (endIndex = count);
          totalSize = count * itemSize;
        }
      }

      if (endIndex - startIndex > config.itemsLimit) {
        this.itemsLimitError();
      }

      this.totalSize = totalSize;
      let view;
      const continuous = startIndex <= this.$_endIndex && endIndex >= this.$_startIndex;
      let unusedIndex;

      if (this.$_continuous !== continuous) {
        if (continuous) {
          views.clear();
          unusedViews.clear();

          for (let i = 0, l = pool.length; i < l; i++) {
            view = pool[i];
            this.unuseView(view);
          }
        }

        this.$_continuous = continuous;
      } else if (continuous) {
        for (let i = 0, l = pool.length; i < l; i++) {
          view = pool[i];

          if (view.nr.used) {
            // Update view item index
            if (checkItem) {
              view.nr.index = items.findIndex(item => keyField ? item[keyField] === view.item[keyField] : item === view.item);
            } // Check if index is still in visible range


            if (view.nr.index === -1 || view.nr.index < startIndex || view.nr.index >= endIndex) {
              this.unuseView(view);
            }
          }
        }
      }

      if (!continuous) {
        unusedIndex = new Map();
      }

      let item, type, unusedPool;
      let v;

      for (let i = startIndex; i < endIndex; i++) {
        item = items[i];
        const key = keyField ? item[keyField] : item;

        if (key == null) {
          throw new Error("Key is " + key + " on item (keyField is '" + keyField + "')");
        }

        view = views.get(key);

        if (!itemSize && !sizes[i].size) {
          if (view) this.unuseView(view);
          continue;
        } // No view assigned to item


        if (!view) {
          type = item[typeField];

          if (continuous) {
            unusedPool = unusedViews.get(type); // Reuse existing view

            if (unusedPool && unusedPool.length) {
              view = unusedPool.pop();
              view.item = item;
              view.nr.used = true;
              view.nr.index = i;
              view.nr.key = key;
              view.nr.type = type;
            } else {
              view = this.addView(pool, i, item, key, type);
            }
          } else {
            unusedPool = unusedViews.get(type);
            v = unusedIndex.get(type) || 0; // Use existing view
            // We don't care if they are already used
            // because we are not in continous scrolling

            if (unusedPool && v < unusedPool.length) {
              view = unusedPool[v];
              view.item = item;
              view.nr.used = true;
              view.nr.index = i;
              view.nr.key = key;
              view.nr.type = type;
              unusedIndex.set(type, v + 1);
            } else {
              view = this.addView(pool, i, item, key, type);
              this.unuseView(view, true);
            }

            v++;
          }

          views.set(key, view);
        } else {
          view.nr.used = true;
          view.item = item;
        } // Update position


        if (itemSize === null) {
          view.position = sizes[i - 1].accumulator;
        } else {
          view.position = i * itemSize;
        }
      }

      this.$_startIndex = startIndex;
      this.$_endIndex = endIndex;
      if (this.emitUpdate) this.$emit('update', startIndex, endIndex);
      return {
        continuous
      };
    },

    getListenerTarget() {
      let target = ScrollParent(this.$el); // Fix global scroll target for Chrome and Safari

      if (window.document && (target === window.document.documentElement || target === window.document.body)) {
        target = window;
      }

      return target;
    },

    getScroll() {
      const {
        $el: el,
        direction
      } = this;
      const isVertical = direction === 'vertical';
      let scrollState;

      if (this.pageMode) {
        const bounds = el.getBoundingClientRect();
        const boundsSize = isVertical ? bounds.height : bounds.width;
        let start = -(isVertical ? bounds.top : bounds.left);
        let size = isVertical ? window.innerHeight : window.innerWidth;

        if (start < 0) {
          size += start;
          start = 0;
        }

        if (start + size > boundsSize) {
          size = boundsSize - start;
        }

        scrollState = {
          start,
          end: start + size
        };
      } else if (isVertical) {
        scrollState = {
          start: el.scrollTop,
          end: el.scrollTop + el.clientHeight
        };
      } else {
        scrollState = {
          start: el.scrollLeft,
          end: el.scrollLeft + el.clientWidth
        };
      }

      return scrollState;
    },

    applyPageMode() {
      if (this.pageMode) {
        this.addListeners();
      } else {
        this.removeListeners();
      }
    },

    addListeners() {
      this.listenerTarget = this.getListenerTarget();
      this.listenerTarget.addEventListener('scroll', this.handleScroll, supportsPassive ? {
        passive: true
      } : false);
      this.listenerTarget.addEventListener('resize', this.handleResize);
    },

    removeListeners() {
      if (!this.listenerTarget) {
        return;
      }

      this.listenerTarget.removeEventListener('scroll', this.handleScroll);
      this.listenerTarget.removeEventListener('resize', this.handleResize);
      this.listenerTarget = null;
    },

    scrollToItem(index) {
      let scroll;

      if (this.itemSize === null) {
        scroll = index > 0 ? this.sizes[index - 1].accumulator : 0;
      } else {
        scroll = index * this.itemSize;
      }

      this.scrollToPosition(scroll);
    },

    scrollToPosition(position) {
      if (this.direction === 'vertical') {
        this.$el.scrollTop = position;
      } else {
        this.$el.scrollLeft = position;
      }
    },

    itemsLimitError() {
      setTimeout(() => {
        console.log("It seems the scroller element isn't scrolling, so it tries to render all the items at once.", 'Scroller:', this.$el);
        console.log("Make sure the scroller has a fixed height (or width) and 'overflow-y' (or 'overflow-x') set to 'auto' so it can scroll correctly and only render the items visible in the scroll viewport.");
      });
      throw new Error('Rendered items limit reached');
    }

  }
};

function normalizeComponent(template, style, script, scopeId, isFunctionalTemplate, moduleIdentifier
/* server only */
, shadowMode, createInjector, createInjectorSSR, createInjectorShadow) {
  if (typeof shadowMode !== 'boolean') {
    createInjectorSSR = createInjector;
    createInjector = shadowMode;
    shadowMode = false;
  } // Vue.extend constructor export interop.


  var options = typeof script === 'function' ? script.options : script; // render functions

  if (template && template.render) {
    options.render = template.render;
    options.staticRenderFns = template.staticRenderFns;
    options._compiled = true; // functional template

    if (isFunctionalTemplate) {
      options.functional = true;
    }
  } // scopedId


  if (scopeId) {
    options._scopeId = scopeId;
  }

  var hook;

  if (moduleIdentifier) {
    // server build
    hook = function hook(context) {
      // 2.3 injection
      context = context || // cached call
      this.$vnode && this.$vnode.ssrContext || // stateful
      this.parent && this.parent.$vnode && this.parent.$vnode.ssrContext; // functional
      // 2.2 with runInNewContext: true

      if (!context && typeof __VUE_SSR_CONTEXT__ !== 'undefined') {
        context = __VUE_SSR_CONTEXT__;
      } // inject component styles


      if (style) {
        style.call(this, createInjectorSSR(context));
      } // register component module identifier for async chunk inference


      if (context && context._registeredComponents) {
        context._registeredComponents.add(moduleIdentifier);
      }
    }; // used by ssr in case component is cached and beforeCreate
    // never gets called


    options._ssrRegister = hook;
  } else if (style) {
    hook = shadowMode ? function () {
      style.call(this, createInjectorShadow(this.$root.$options.shadowRoot));
    } : function (context) {
      style.call(this, createInjector(context));
    };
  }

  if (hook) {
    if (options.functional) {
      // register for functional component in vue file
      var originalRender = options.render;

      options.render = function renderWithStyleInjection(h, context) {
        hook.call(context);
        return originalRender(h, context);
      };
    } else {
      // inject component registration as beforeCreate hook
      var existing = options.beforeCreate;
      options.beforeCreate = existing ? [].concat(existing, hook) : [hook];
    }
  }

  return script;
}

var normalizeComponent_1 = normalizeComponent;

var isOldIE = typeof navigator !== 'undefined' && /msie [6-9]\\b/.test(navigator.userAgent.toLowerCase());
function createInjector(context) {
  return function (id, style) {
    return addStyle(id, style);
  };
}
var HEAD = document.head || document.getElementsByTagName('head')[0];
var styles = {};

function addStyle(id, css) {
  var group = isOldIE ? css.media || 'default' : id;
  var style = styles[group] || (styles[group] = {
    ids: new Set(),
    styles: []
  });

  if (!style.ids.has(id)) {
    style.ids.add(id);
    var code = css.source;

    if (css.map) {
      // https://developer.chrome.com/devtools/docs/javascript-debugging
      // this makes source maps inside style tags work properly in Chrome
      code += '\n/*# sourceURL=' + css.map.sources[0] + ' */'; // http://stackoverflow.com/a/26603875

      code += '\n/*# sourceMappingURL=data:application/json;base64,' + btoa(unescape(encodeURIComponent(JSON.stringify(css.map)))) + ' */';
    }

    if (!style.element) {
      style.element = document.createElement('style');
      style.element.type = 'text/css';
      if (css.media) style.element.setAttribute('media', css.media);
      HEAD.appendChild(style.element);
    }

    if ('styleSheet' in style.element) {
      style.styles.push(code);
      style.element.styleSheet.cssText = style.styles.filter(Boolean).join('\n');
    } else {
      var index = style.ids.size - 1;
      var textNode = document.createTextNode(code);
      var nodes = style.element.childNodes;
      if (nodes[index]) style.element.removeChild(nodes[index]);
      if (nodes.length) style.element.insertBefore(textNode, nodes[index]);else style.element.appendChild(textNode);
    }
  }
}

var browser = createInjector;

/* script */
const __vue_script__ = script;

/* template */
var __vue_render__ = function() {
  var _obj, _obj$1;
  var _vm = this;
  var _h = _vm.$createElement;
  var _c = _vm._self._c || _h;
  return _c(
    "div",
    {
      directives: [
        {
          name: "observe-visibility",
          rawName: "v-observe-visibility",
          value: _vm.handleVisibilityChange,
          expression: "handleVisibilityChange"
        }
      ],
      staticClass: "vue-recycle-scroller",
      class: ((_obj = {
        ready: _vm.ready,
        "page-mode": _vm.pageMode
      }),
      (_obj["direction-" + _vm.direction] = true),
      _obj),
      on: {
        "&scroll": function($event) {
          return _vm.handleScroll($event)
        }
      }
    },
    [
      _vm.$slots.before
        ? _c(
            "div",
            { staticClass: "vue-recycle-scroller__slot" },
            [_vm._t("before")],
            2
          )
        : _vm._e(),
      _vm._v(" "),
      _c(
        "div",
        {
          ref: "wrapper",
          staticClass: "vue-recycle-scroller__item-wrapper",
          style: ((_obj$1 = {}),
          (_obj$1[_vm.direction === "vertical" ? "minHeight" : "minWidth"] =
            _vm.totalSize + "px"),
          _obj$1)
        },
        _vm._l(_vm.pool, function(view) {
          return _c(
            "div",
            {
              key: view.nr.id,
              staticClass: "vue-recycle-scroller__item-view",
              style: _vm.ready
                ? {
                    transform:
                      "translate" +
                      (_vm.direction === "vertical" ? "Y" : "X") +
                      "(" +
                      view.position +
                      "px)"
                  }
                : null
            },
            [
              _vm._t("default", null, {
                item: view.item,
                index: view.nr.index,
                active: view.nr.used
              })
            ],
            2
          )
        }),
        0
      ),
      _vm._v(" "),
      _vm.$slots.after
        ? _c(
            "div",
            { staticClass: "vue-recycle-scroller__slot" },
            [_vm._t("after")],
            2
          )
        : _vm._e(),
      _vm._v(" "),
      _c("ResizeObserver", { on: { notify: _vm.handleResize } })
    ],
    1
  )
};
var __vue_staticRenderFns__ = [];
__vue_render__._withStripped = true;

  /* style */
  const __vue_inject_styles__ = function (inject) {
    if (!inject) return
    inject("data-v-99e53d5c_0", { source: "\n.vue-recycle-scroller {\n  position: relative;\n}\n.vue-recycle-scroller.direction-vertical:not(.page-mode) {\n  overflow-y: auto;\n}\n.vue-recycle-scroller.direction-horizontal:not(.page-mode) {\n  overflow-x: auto;\n}\n.vue-recycle-scroller.direction-horizontal {\n  display: flex;\n}\n.vue-recycle-scroller__slot {\n  flex: auto 0 0;\n}\n.vue-recycle-scroller__item-wrapper {\n  flex: 1;\n  box-sizing: border-box;\n  overflow: hidden;\n  position: relative;\n}\n.vue-recycle-scroller.ready .vue-recycle-scroller__item-view {\n  position: absolute;\n  top: 0;\n  left: 0;\n  will-change: transform;\n}\n.vue-recycle-scroller.direction-vertical .vue-recycle-scroller__item-wrapper {\n  width: 100%;\n}\n.vue-recycle-scroller.direction-horizontal .vue-recycle-scroller__item-wrapper {\n  height: 100%;\n}\n.vue-recycle-scroller.ready.direction-vertical .vue-recycle-scroller__item-view {\n  width: 100%;\n}\n.vue-recycle-scroller.ready.direction-horizontal .vue-recycle-scroller__item-view {\n  height: 100%;\n}\n", map: {"version":3,"sources":["/home/alex/dev/foss/vue-virtual-scroller/src/components/RecycleScroller.vue"],"names":[],"mappings":";AAijBA;EACA,kBAAA;AACA;AAEA;EACA,gBAAA;AACA;AAEA;EACA,gBAAA;AACA;AAEA;EACA,aAAA;AACA;AAEA;EACA,cAAA;AACA;AAEA;EACA,OAAA;EACA,sBAAA;EACA,gBAAA;EACA,kBAAA;AACA;AAEA;EACA,kBAAA;EACA,MAAA;EACA,OAAA;EACA,sBAAA;AACA;AAEA;EACA,WAAA;AACA;AAEA;EACA,YAAA;AACA;AAEA;EACA,WAAA;AACA;AAEA;EACA,YAAA;AACA","file":"RecycleScroller.vue","sourcesContent":["<template>\n  <div\n    v-observe-visibility=\"handleVisibilityChange\"\n    class=\"vue-recycle-scroller\"\n    :class=\"{\n      ready,\n      'page-mode': pageMode,\n      [`direction-${direction}`]: true,\n    }\"\n    @scroll.passive=\"handleScroll\"\n  >\n    <div\n      v-if=\"$slots.before\"\n      class=\"vue-recycle-scroller__slot\"\n    >\n      <slot\n        name=\"before\"\n      />\n    </div>\n\n    <div\n      ref=\"wrapper\"\n      :style=\"{ [direction === 'vertical' ? 'minHeight' : 'minWidth']: totalSize + 'px' }\"\n      class=\"vue-recycle-scroller__item-wrapper\"\n    >\n      <div\n        v-for=\"view of pool\"\n        :key=\"view.nr.id\"\n        :style=\"ready ? { transform: `translate${direction === 'vertical' ? 'Y' : 'X'}(${view.position}px)` } : null\"\n        class=\"vue-recycle-scroller__item-view\"\n      >\n        <slot\n          :item=\"view.item\"\n          :index=\"view.nr.index\"\n          :active=\"view.nr.used\"\n        />\n      </div>\n    </div>\n\n    <div\n      v-if=\"$slots.after\"\n      class=\"vue-recycle-scroller__slot\"\n    >\n      <slot\n        name=\"after\"\n      />\n    </div>\n\n    <ResizeObserver @notify=\"handleResize\" />\n  </div>\n</template>\n\n<script>\nimport { ResizeObserver } from 'vue-resize'\nimport { ObserveVisibility } from 'vue-observe-visibility'\nimport ScrollParent from 'scrollparent'\nimport config from '../config'\nimport { props, simpleArray } from './common'\nimport { supportsPassive } from '../utils'\n\nlet uid = 0\n\nexport default {\n  name: 'RecycleScroller',\n\n  components: {\n    ResizeObserver,\n  },\n\n  directives: {\n    ObserveVisibility,\n  },\n\n  props: {\n    ...props,\n\n    itemSize: {\n      type: Number,\n      default: null,\n    },\n\n    minItemSize: {\n      type: [Number, String],\n      default: null,\n    },\n\n    sizeField: {\n      type: String,\n      default: 'size',\n    },\n\n    typeField: {\n      type: String,\n      default: 'type',\n    },\n\n    buffer: {\n      type: Number,\n      default: 200,\n    },\n\n    pageMode: {\n      type: Boolean,\n      default: false,\n    },\n\n    prerender: {\n      type: Number,\n      default: 0,\n    },\n\n    emitUpdate: {\n      type: Boolean,\n      default: false,\n    },\n  },\n\n  data () {\n    return {\n      pool: [],\n      totalSize: 0,\n      ready: false,\n    }\n  },\n\n  computed: {\n    sizes () {\n      if (this.itemSize === null) {\n        const sizes = {\n          '-1': { accumulator: 0 },\n        }\n        const items = this.items\n        const field = this.sizeField\n        const minItemSize = this.minItemSize\n        let accumulator = 0\n        let current\n        for (let i = 0, l = items.length; i < l; i++) {\n          current = items[i][field] || minItemSize\n          accumulator += current\n          sizes[i] = { accumulator, size: current }\n        }\n        return sizes\n      }\n      return []\n    },\n\n    simpleArray,\n  },\n\n  watch: {\n    items () {\n      this.updateVisibleItems(true)\n    },\n\n    pageMode () {\n      this.applyPageMode()\n      this.updateVisibleItems(false)\n    },\n\n    sizes: {\n      handler () {\n        this.updateVisibleItems(false)\n      },\n      deep: true,\n    },\n  },\n\n  created () {\n    this.$_startIndex = 0\n    this.$_endIndex = 0\n    this.$_views = new Map()\n    this.$_unusedViews = new Map()\n    this.$_scrollDirty = false\n\n    if (this.$isServer) {\n      this.updateVisibleItems(false)\n    }\n  },\n\n  mounted () {\n    this.applyPageMode()\n    this.$nextTick(() => {\n      this.updateVisibleItems(true)\n      this.ready = true\n    })\n  },\n\n  beforeDestroy () {\n    this.removeListeners()\n  },\n\n  methods: {\n    addView (pool, index, item, key, type) {\n      const view = {\n        item,\n        position: 0,\n      }\n      const nonReactive = {\n        id: uid++,\n        index,\n        used: true,\n        key,\n        type,\n      }\n      Object.defineProperty(view, 'nr', {\n        configurable: false,\n        value: nonReactive,\n      })\n      pool.push(view)\n      return view\n    },\n\n    unuseView (view, fake = false) {\n      const unusedViews = this.$_unusedViews\n      const type = view.nr.type\n      let unusedPool = unusedViews.get(type)\n      if (!unusedPool) {\n        unusedPool = []\n        unusedViews.set(type, unusedPool)\n      }\n      unusedPool.push(view)\n      if (!fake) {\n        view.nr.used = false\n        view.position = -9999\n        this.$_views.delete(view.nr.key)\n      }\n    },\n\n    handleResize () {\n      this.$emit('resize')\n      if (this.ready) this.updateVisibleItems(false)\n    },\n\n    handleScroll (event) {\n      if (!this.$_scrollDirty) {\n        this.$_scrollDirty = true\n        requestAnimationFrame(() => {\n          this.$_scrollDirty = false\n          const { continuous } = this.updateVisibleItems(false)\n\n          // It seems sometimes chrome doesn't fire scroll event :/\n          // When non continous scrolling is ending, we force a refresh\n          if (!continuous) {\n            clearTimeout(this.$_refreshTimout)\n            this.$_refreshTimout = setTimeout(this.handleScroll, 100)\n          }\n        })\n      }\n    },\n\n    handleVisibilityChange (isVisible, entry) {\n      if (this.ready) {\n        if (isVisible || entry.boundingClientRect.width !== 0 || entry.boundingClientRect.height !== 0) {\n          this.$emit('visible')\n          requestAnimationFrame(() => {\n            this.updateVisibleItems(false)\n          })\n        } else {\n          this.$emit('hidden')\n        }\n      }\n    },\n\n    updateVisibleItems (checkItem) {\n      const itemSize = this.itemSize\n      const typeField = this.typeField\n      const keyField = this.simpleArray ? null : this.keyField\n      const items = this.items\n      const count = items.length\n      const sizes = this.sizes\n      const views = this.$_views\n      let unusedViews = this.$_unusedViews\n      const pool = this.pool\n      let startIndex, endIndex\n      let totalSize\n\n      if (!count) {\n        startIndex = endIndex = totalSize = 0\n      } else if (this.$isServer) {\n        startIndex = 0\n        endIndex = this.prerender\n        totalSize = null\n      } else {\n        const scroll = this.getScroll()\n        const buffer = this.buffer\n        scroll.start -= buffer\n        scroll.end += buffer\n\n        // Variable size mode\n        if (itemSize === null) {\n          let h\n          let a = 0\n          let b = count - 1\n          let i = ~~(count / 2)\n          let oldI\n\n          // Searching for startIndex\n          do {\n            oldI = i\n            h = sizes[i].accumulator\n            if (h < scroll.start) {\n              a = i\n            } else if (i < count - 1 && sizes[i + 1].accumulator > scroll.start) {\n              b = i\n            }\n            i = ~~((a + b) / 2)\n          } while (i !== oldI)\n          i < 0 && (i = 0)\n          startIndex = i\n\n          // For container style\n          totalSize = sizes[count - 1].accumulator\n\n          // Searching for endIndex\n          for (endIndex = i; endIndex < count && sizes[endIndex].accumulator < scroll.end; endIndex++);\n          if (endIndex === -1) {\n            endIndex = items.length - 1\n          } else {\n            endIndex++\n            // Bounds\n            endIndex > count && (endIndex = count)\n          }\n        } else {\n          // Fixed size mode\n          startIndex = ~~(scroll.start / itemSize)\n          endIndex = Math.ceil(scroll.end / itemSize)\n\n          // Bounds\n          startIndex < 0 && (startIndex = 0)\n          endIndex > count && (endIndex = count)\n\n          totalSize = count * itemSize\n        }\n      }\n\n      if (endIndex - startIndex > config.itemsLimit) {\n        this.itemsLimitError()\n      }\n\n      this.totalSize = totalSize\n\n      let view\n\n      const continuous = startIndex <= this.$_endIndex && endIndex >= this.$_startIndex\n      let unusedIndex\n\n      if (this.$_continuous !== continuous) {\n        if (continuous) {\n          views.clear()\n          unusedViews.clear()\n          for (let i = 0, l = pool.length; i < l; i++) {\n            view = pool[i]\n            this.unuseView(view)\n          }\n        }\n        this.$_continuous = continuous\n      } else if (continuous) {\n        for (let i = 0, l = pool.length; i < l; i++) {\n          view = pool[i]\n          if (view.nr.used) {\n            // Update view item index\n            if (checkItem) {\n              view.nr.index = items.findIndex(\n                item => keyField ? item[keyField] === view.item[keyField] : item === view.item\n              )\n            }\n\n            // Check if index is still in visible range\n            if (\n              view.nr.index === -1 ||\n              view.nr.index < startIndex ||\n              view.nr.index >= endIndex\n            ) {\n              this.unuseView(view)\n            }\n          }\n        }\n      }\n\n      if (!continuous) {\n        unusedIndex = new Map()\n      }\n\n      let item, type, unusedPool\n      let v\n      for (let i = startIndex; i < endIndex; i++) {\n        item = items[i]\n        const key = keyField ? item[keyField] : item\n        if (key == null) {\n          throw new Error(`Key is ${key} on item (keyField is '${keyField}')`)\n        }\n        view = views.get(key)\n\n        if (!itemSize && !sizes[i].size) {\n          if (view) this.unuseView(view)\n          continue\n        }\n\n        // No view assigned to item\n        if (!view) {\n          type = item[typeField]\n\n          if (continuous) {\n            unusedPool = unusedViews.get(type)\n            // Reuse existing view\n            if (unusedPool && unusedPool.length) {\n              view = unusedPool.pop()\n              view.item = item\n              view.nr.used = true\n              view.nr.index = i\n              view.nr.key = key\n              view.nr.type = type\n            } else {\n              view = this.addView(pool, i, item, key, type)\n            }\n          } else {\n            unusedPool = unusedViews.get(type)\n            v = unusedIndex.get(type) || 0\n            // Use existing view\n            // We don't care if they are already used\n            // because we are not in continous scrolling\n            if (unusedPool && v < unusedPool.length) {\n              view = unusedPool[v]\n              view.item = item\n              view.nr.used = true\n              view.nr.index = i\n              view.nr.key = key\n              view.nr.type = type\n              unusedIndex.set(type, v + 1)\n            } else {\n              view = this.addView(pool, i, item, key, type)\n              this.unuseView(view, true)\n            }\n            v++\n          }\n          views.set(key, view)\n        } else {\n          view.nr.used = true\n          view.item = item\n        }\n\n        // Update position\n        if (itemSize === null) {\n          view.position = sizes[i - 1].accumulator\n        } else {\n          view.position = i * itemSize\n        }\n      }\n\n      this.$_startIndex = startIndex\n      this.$_endIndex = endIndex\n\n      if (this.emitUpdate) this.$emit('update', startIndex, endIndex)\n\n      return {\n        continuous,\n      }\n    },\n\n    getListenerTarget () {\n      let target = ScrollParent(this.$el)\n      // Fix global scroll target for Chrome and Safari\n      if (window.document && (target === window.document.documentElement || target === window.document.body)) {\n        target = window\n      }\n      return target\n    },\n\n    getScroll () {\n      const { $el: el, direction } = this\n      const isVertical = direction === 'vertical'\n      let scrollState\n\n      if (this.pageMode) {\n        const bounds = el.getBoundingClientRect()\n        const boundsSize = isVertical ? bounds.height : bounds.width\n        let start = -(isVertical ? bounds.top : bounds.left)\n        let size = isVertical ? window.innerHeight : window.innerWidth\n        if (start < 0) {\n          size += start\n          start = 0\n        }\n        if (start + size > boundsSize) {\n          size = boundsSize - start\n        }\n        scrollState = {\n          start,\n          end: start + size,\n        }\n      } else if (isVertical) {\n        scrollState = {\n          start: el.scrollTop,\n          end: el.scrollTop + el.clientHeight,\n        }\n      } else {\n        scrollState = {\n          start: el.scrollLeft,\n          end: el.scrollLeft + el.clientWidth,\n        }\n      }\n\n      return scrollState\n    },\n\n    applyPageMode () {\n      if (this.pageMode) {\n        this.addListeners()\n      } else {\n        this.removeListeners()\n      }\n    },\n\n    addListeners () {\n      this.listenerTarget = this.getListenerTarget()\n      this.listenerTarget.addEventListener('scroll', this.handleScroll, supportsPassive ? {\n        passive: true,\n      } : false)\n      this.listenerTarget.addEventListener('resize', this.handleResize)\n    },\n\n    removeListeners () {\n      if (!this.listenerTarget) {\n        return\n      }\n\n      this.listenerTarget.removeEventListener('scroll', this.handleScroll)\n      this.listenerTarget.removeEventListener('resize', this.handleResize)\n\n      this.listenerTarget = null\n    },\n\n    scrollToItem (index) {\n      let scroll\n      if (this.itemSize === null) {\n        scroll = index > 0 ? this.sizes[index - 1].accumulator : 0\n      } else {\n        scroll = index * this.itemSize\n      }\n      this.scrollToPosition(scroll)\n    },\n\n    scrollToPosition (position) {\n      if (this.direction === 'vertical') {\n        this.$el.scrollTop = position\n      } else {\n        this.$el.scrollLeft = position\n      }\n    },\n\n    itemsLimitError () {\n      setTimeout(() => {\n        console.log(`It seems the scroller element isn't scrolling, so it tries to render all the items at once.`, 'Scroller:', this.$el)\n        console.log(`Make sure the scroller has a fixed height (or width) and 'overflow-y' (or 'overflow-x') set to 'auto' so it can scroll correctly and only render the items visible in the scroll viewport.`)\n      })\n      throw new Error('Rendered items limit reached')\n    },\n  },\n}\n</script>\n\n<style>\n.vue-recycle-scroller {\n  position: relative;\n}\n\n.vue-recycle-scroller.direction-vertical:not(.page-mode) {\n  overflow-y: auto;\n}\n\n.vue-recycle-scroller.direction-horizontal:not(.page-mode) {\n  overflow-x: auto;\n}\n\n.vue-recycle-scroller.direction-horizontal {\n  display: flex;\n}\n\n.vue-recycle-scroller__slot {\n  flex: auto 0 0;\n}\n\n.vue-recycle-scroller__item-wrapper {\n  flex: 1;\n  box-sizing: border-box;\n  overflow: hidden;\n  position: relative;\n}\n\n.vue-recycle-scroller.ready .vue-recycle-scroller__item-view {\n  position: absolute;\n  top: 0;\n  left: 0;\n  will-change: transform;\n}\n\n.vue-recycle-scroller.direction-vertical .vue-recycle-scroller__item-wrapper {\n  width: 100%;\n}\n\n.vue-recycle-scroller.direction-horizontal .vue-recycle-scroller__item-wrapper {\n  height: 100%;\n}\n\n.vue-recycle-scroller.ready.direction-vertical .vue-recycle-scroller__item-view {\n  width: 100%;\n}\n\n.vue-recycle-scroller.ready.direction-horizontal .vue-recycle-scroller__item-view {\n  height: 100%;\n}\n</style>\n"]}, media: undefined });

  };
  /* scoped */
  const __vue_scope_id__ = undefined;
  /* module identifier */
  const __vue_module_identifier__ = undefined;
  /* functional template */
  const __vue_is_functional_template__ = false;
  /* style inject SSR */
  

  
  var RecycleScroller = normalizeComponent_1(
    { render: __vue_render__, staticRenderFns: __vue_staticRenderFns__ },
    __vue_inject_styles__,
    __vue_script__,
    __vue_scope_id__,
    __vue_is_functional_template__,
    __vue_module_identifier__,
    browser,
    undefined
  );

var script$1 = {
  name: 'DynamicScroller',
  components: {
    RecycleScroller
  },
  inheritAttrs: false,

  provide() {
    return {
      vscrollData: this.vscrollData,
      vscrollParent: this
    };
  },

  props: _extends({}, props, {
    minItemSize: {
      type: [Number, String],
      required: true
    }
  }),

  data() {
    return {
      vscrollData: {
        active: true,
        sizes: {},
        validSizes: {},
        keyField: this.keyField,
        simpleArray: false
      }
    };
  },

  computed: {
    simpleArray,

    itemsWithSize() {
      const result = [];
      const {
        items,
        keyField,
        simpleArray
      } = this;
      const sizes = this.vscrollData.sizes;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const id = simpleArray ? i : item[keyField];
        let size = sizes[id];

        if (typeof size === 'undefined' && !this.$_undefinedMap[id]) {
          // eslint-disable-next-line vue/no-side-effects-in-computed-properties
          this.$_undefinedSizes++; // eslint-disable-next-line vue/no-side-effects-in-computed-properties

          this.$_undefinedMap[id] = true;
          size = 0;
        }

        result.push({
          item,
          id,
          size
        });
      }

      return result;
    },

    listeners() {
      const listeners = {};

      for (const key in this.$listeners) {
        if (key !== 'resize' && key !== 'visible') {
          listeners[key] = this.$listeners[key];
        }
      }

      return listeners;
    }

  },
  watch: {
    items() {
      this.forceUpdate(false);
    },

    simpleArray: {
      handler(value) {
        this.vscrollData.simpleArray = value;
      },

      immediate: true
    },

    direction(value) {
      this.forceUpdate(true);
    }

  },

  created() {
    this.$_updates = [];
    this.$_undefinedSizes = 0;
    this.$_undefinedMap = {};
  },

  activated() {
    this.vscrollData.active = true;
  },

  deactivated() {
    this.vscrollData.active = false;
  },

  methods: {
    onScrollerResize() {
      const scroller = this.$refs.scroller;

      if (scroller) {
        this.forceUpdate();
      }

      this.$emit('resize');
    },

    onScrollerVisible() {
      this.$emit('vscroll:update', {
        force: false
      });
      this.$emit('visible');
    },

    forceUpdate(clear) {
      if (clear === void 0) {
        clear = true;
      }

      if (clear || this.simpleArray) {
        this.vscrollData.validSizes = {};
      }

      this.$emit('vscroll:update', {
        force: true
      });
    },

    scrollToItem(index) {
      const scroller = this.$refs.scroller;
      if (scroller) scroller.scrollToItem(index);
    },

    getItemSize(item, index) {
      if (index === void 0) {
        index = undefined;
      }

      const id = this.simpleArray ? index != null ? index : this.items.indexOf(item) : item[this.keyField];
      return this.vscrollData.sizes[id] || 0;
    },

    scrollToBottom() {
      if (this.$_scrollingToBottom) return;
      this.$_scrollingToBottom = true;
      const el = this.$el; // Item is inserted to the DOM

      this.$nextTick(() => {
        // Item sizes are computed
        const cb = () => {
          el.scrollTop = el.scrollHeight;

          if (this.$_undefinedSizes === 0) {
            this.$_scrollingToBottom = false;
          } else {
            requestAnimationFrame(cb);
          }
        };

        requestAnimationFrame(cb);
      });
    }

  }
};

/* script */
const __vue_script__$1 = script$1;

/* template */
var __vue_render__$1 = function() {
  var _vm = this;
  var _h = _vm.$createElement;
  var _c = _vm._self._c || _h;
  return _c(
    "RecycleScroller",
    _vm._g(
      _vm._b(
        {
          ref: "scroller",
          attrs: {
            items: _vm.itemsWithSize,
            "min-item-size": _vm.minItemSize,
            direction: _vm.direction,
            "key-field": "id"
          },
          on: { resize: _vm.onScrollerResize, visible: _vm.onScrollerVisible },
          scopedSlots: _vm._u([
            {
              key: "default",
              fn: function(ref) {
                var itemWithSize = ref.item;
                var index = ref.index;
                var active = ref.active;
                return [
                  _vm._t("default", null, null, {
                    item: itemWithSize.item,
                    index: index,
                    active: active,
                    itemWithSize: itemWithSize
                  })
                ]
              }
            }
          ])
        },
        "RecycleScroller",
        _vm.$attrs,
        false
      ),
      _vm.listeners
    ),
    [
      _c("template", { slot: "before" }, [_vm._t("before")], 2),
      _vm._v(" "),
      _c("template", { slot: "after" }, [_vm._t("after")], 2)
    ],
    2
  )
};
var __vue_staticRenderFns__$1 = [];
__vue_render__$1._withStripped = true;

  /* style */
  const __vue_inject_styles__$1 = undefined;
  /* scoped */
  const __vue_scope_id__$1 = undefined;
  /* module identifier */
  const __vue_module_identifier__$1 = undefined;
  /* functional template */
  const __vue_is_functional_template__$1 = false;
  /* style inject */
  
  /* style inject SSR */
  

  
  var DynamicScroller = normalizeComponent_1(
    { render: __vue_render__$1, staticRenderFns: __vue_staticRenderFns__$1 },
    __vue_inject_styles__$1,
    __vue_script__$1,
    __vue_scope_id__$1,
    __vue_is_functional_template__$1,
    __vue_module_identifier__$1,
    undefined,
    undefined
  );

var script$2 = {
  name: 'DynamicScrollerItem',
  inject: ['vscrollData', 'vscrollParent'],
  props: {
    item: {
      required: true
    },
    watchData: {
      type: Boolean,
      default: false
    },
    active: {
      type: Boolean,
      required: true
    },
    index: {
      type: Number,
      default: undefined
    },
    sizeDependencies: {
      type: [Array, Object],
      default: null
    },
    emitResize: {
      type: Boolean,
      default: false
    },
    tag: {
      type: String,
      default: 'div'
    }
  },
  computed: {
    id() {
      return this.vscrollData.simpleArray ? this.index : this.item[this.vscrollData.keyField];
    },

    size() {
      return this.vscrollData.validSizes[this.id] && this.vscrollData.sizes[this.id] || 0;
    }

  },
  watch: {
    watchData: 'updateWatchData',

    id() {
      if (!this.size) {
        this.onDataUpdate();
      }
    },

    active(value) {
      if (value && this.$_pendingVScrollUpdate === this.id) {
        this.updateSize();
      }
    }

  },

  created() {
    if (this.$isServer) return;
    this.$_forceNextVScrollUpdate = null;
    this.updateWatchData();

    for (const k in this.sizeDependencies) {
      this.$watch(() => this.sizeDependencies[k], this.onDataUpdate);
    }

    this.vscrollParent.$on('vscroll:update', this.onVscrollUpdate);
    this.vscrollParent.$on('vscroll:update-size', this.onVscrollUpdateSize);
  },

  mounted() {
    if (this.vscrollData.active) {
      this.updateSize();
    }
  },

  beforeDestroy() {
    this.vscrollParent.$off('vscroll:update', this.onVscrollUpdate);
    this.vscrollParent.$off('vscroll:update-size', this.onVscrollUpdateSize);
  },

  methods: {
    updateSize() {
      if (this.active && this.vscrollData.active) {
        if (this.$_pendingSizeUpdate !== this.id) {
          this.$_pendingSizeUpdate = this.id;
          this.$_forceNextVScrollUpdate = null;
          this.$_pendingVScrollUpdate = null;

          if (this.active && this.vscrollData.active) {
            this.computeSize(this.id);
          }
        }
      } else {
        this.$_forceNextVScrollUpdate = this.id;
      }
    },

    getBounds() {
      return this.$el.getBoundingClientRect();
    },

    updateWatchData() {
      if (this.watchData) {
        this.$_watchData = this.$watch('data', () => {
          this.onDataUpdate();
        }, {
          deep: true
        });
      } else if (this.$_watchData) {
        this.$_watchData();
        this.$_watchData = null;
      }
    },

    onVscrollUpdate(_ref) {
      let {
        force
      } = _ref;

      if (!this.active && force) {
        this.$_pendingVScrollUpdate = this.id;
      }

      if (this.$_forceNextVScrollUpdate === this.id || force || !this.size) {
        this.updateSize();
      }
    },

    onDataUpdate() {
      this.updateSize();
    },

    computeSize(id) {
      this.$nextTick(() => {
        if (this.id === id) {
          const bounds = this.getBounds();
          const size = Math.round(this.vscrollParent.direction === 'vertical' ? bounds.height : bounds.width);

          if (size && this.size !== size) {
            if (this.vscrollParent.$_undefinedMap[id]) {
              this.vscrollParent.$_undefinedSizes--;
              this.vscrollParent.$_undefinedMap[id] = undefined;
            }

            this.$set(this.vscrollData.sizes, this.id, size);
            this.$set(this.vscrollData.validSizes, this.id, true);
            if (this.emitResize) this.$emit('resize', this.id);
          }
        }

        this.$_pendingSizeUpdate = null;
      });
    }

  },

  render(h) {
    return h(this.tag, this.$slots.default);
  }

};

/* script */
const __vue_script__$2 = script$2;

/* template */

  /* style */
  const __vue_inject_styles__$2 = undefined;
  /* scoped */
  const __vue_scope_id__$2 = undefined;
  /* module identifier */
  const __vue_module_identifier__$2 = undefined;
  /* functional template */
  const __vue_is_functional_template__$2 = undefined;
  /* style inject */
  
  /* style inject SSR */
  

  
  var DynamicScrollerItem = normalizeComponent_1(
    {},
    __vue_inject_styles__$2,
    __vue_script__$2,
    __vue_scope_id__$2,
    __vue_is_functional_template__$2,
    __vue_module_identifier__$2,
    undefined,
    undefined
  );

function IdState (_temp) {
  let {
    idProp = vm => vm.item.id
  } = _temp === void 0 ? {} : _temp;
  const store = {};
  const vm = new Vue({
    data() {
      return {
        store
      };
    }

  }); // @vue/component

  return {
    data() {
      return {
        idState: null
      };
    },

    created() {
      this.$_id = null;

      if (typeof idProp === 'function') {
        this.$_getId = () => idProp.call(this, this);
      } else {
        this.$_getId = () => this[idProp];
      }

      this.$watch(this.$_getId, {
        handler(value) {
          this.$nextTick(() => {
            this.$_id = value;
          });
        },

        immediate: true
      });
      this.$_updateIdState();
    },

    beforeUpdate() {
      this.$_updateIdState();
    },

    methods: {
      /**
       * Initialize an idState
       * @param {number|string} id Unique id for the data
       */
      $_idStateInit(id) {
        const factory = this.$options.idState;

        if (typeof factory === 'function') {
          const data = factory.call(this, this);
          vm.$set(store, id, data);
          this.$_id = id;
          return data;
        } else {
          throw new Error('[mixin IdState] Missing `idState` function on component definition.');
        }
      },

      /**
       * Ensure idState is created and up-to-date
       */
      $_updateIdState() {
        const id = this.$_getId();

        if (id == null) {
          console.warn("No id found for IdState with idProp: '" + idProp + "'.");
        }

        if (id !== this.$_id) {
          if (!store[id]) {
            this.$_idStateInit(id);
          }

          this.idState = store[id];
        }
      }

    }
  };
}

function registerComponents(Vue, prefix) {
  Vue.component(prefix + "recycle-scroller", RecycleScroller);
  Vue.component(prefix + "RecycleScroller", RecycleScroller);
  Vue.component(prefix + "dynamic-scroller", DynamicScroller);
  Vue.component(prefix + "DynamicScroller", DynamicScroller);
  Vue.component(prefix + "dynamic-scroller-item", DynamicScrollerItem);
  Vue.component(prefix + "DynamicScrollerItem", DynamicScrollerItem);
}

const plugin = {
  // eslint-disable-next-line no-undef
  version: "1.0.0-rc.2",

  install(Vue, options) {
    const finalOptions = Object.assign({}, {
      installComponents: true,
      componentsPrefix: ''
    }, options);

    for (const key in finalOptions) {
      if (typeof finalOptions[key] !== 'undefined') {
        config[key] = finalOptions[key];
      }
    }

    if (finalOptions.installComponents) {
      registerComponents(Vue, finalOptions.componentsPrefix);
    }
  }

};

let GlobalVue = null;

if (typeof window !== 'undefined') {
  GlobalVue = window.Vue;
} else if (typeof global !== 'undefined') {
  GlobalVue = global.Vue;
}

if (GlobalVue) {
  GlobalVue.use(plugin);
}

export default plugin;
export { DynamicScroller, DynamicScrollerItem, IdState, RecycleScroller };
