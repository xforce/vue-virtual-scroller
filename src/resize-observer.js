const defaultDelay = 150

function getOptions (modifiers) {
  if (!modifiers) {
    return {
      delay: defaultDelay,
      initial: false,
    }
  }
  const { initial = false } = modifiers
  let delay = Object.keys(modifiers)
    .map(k => parseInt(k))
    .find(v => !isNaN(v))
  delay = delay || defaultDelay
  return {
    delay,
    initial,
  }
}

// tslint:disable-next-line
const ElementToObserver = new WeakMap()

const ObserveResize = {
  inserted: function (el, { value, arg, modifiers }, { context: component }) {
    if (ElementToObserver.has(el)) {
      return
    }
    const options = getOptions(modifiers)

    //
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.contentRect) {
          value(entry.target)
        }
      }
    })
    observer.observe(el)
    ElementToObserver.set(el, observer)

    if (options.initial) {
      window.requestIdleCallback(() => {
        value(el)
      })
    }
  },
  unbind: function (el, binding) {
    //
    if (!ElementToObserver.has(el)) {
      return
    }

    ElementToObserver.get(el).unobserve(el)
    ElementToObserver.delete(el)
  },
}

// Install the components
export function install (Vue) {
  Vue.directive('observe-resize', ObserveResize)
}

export {
  ObserveResize,
}

// Plugin
const plugin = {
  install,
}

export default plugin
